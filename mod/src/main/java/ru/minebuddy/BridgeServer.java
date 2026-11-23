package ru.minebuddy;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * TCP-сервер на 127.0.0.1, протокол — NDJSON (одна JSON-строка на сообщение).
 *
 * Почему TCP, а не HTTP/WebSocket:
 *  - нулевые зависимости и никакого TLS;
 *  - десктоп-приложение просто держит сокет и читает строки;
 *  - буферизация и переподключение пишутся в 30 строк.
 *
 * Все сетевые операции вынесены в отдельный поток. Игровой поток только
 * кладёт строку в очередь (O(1), без блокировок на I/O).
 */
public final class BridgeServer {
    private final int port;

    private ServerSocket server;
    private Thread acceptThread;
    private Thread writerThread;
    private Thread sweeperThread;

    private final LinkedBlockingQueue<String> outbound = new LinkedBlockingQueue<>(4096);
    private final Map<String, Client> clients = new ConcurrentHashMap<>();
    private final AtomicLong clientSeq = new AtomicLong();

    /** Дропаем клиента, если не удалось записать пакет в течение N подряд. */
    private static final int MAX_WRITE_FAILURES = 3;
    private static final int QUEUE_MAX = 4096;
    private static final long SWEEP_INTERVAL_MS = 5000;

    public BridgeServer(BridgeConfig config) {
        this.port = config.port;
    }

    public void start() {
        try {
            server = new ServerSocket(port, 8, InetAddress.getLoopbackAddress());
        } catch (IOException e) {
            MineBuddyMod.LOG.error("[MineBuddy] Не удалось занять порт {} — мод не будет отдавать события. " +
                    "Проверь, не занят ли порт другой программой.", port, e);
            return;
        }

        acceptThread = new Thread(this::acceptLoop, "MineBuddy-Accept");
        acceptThread.setDaemon(true);
        acceptThread.start();

        writerThread = new Thread(this::writerLoop, "MineBuddy-Writer");
        writerThread.setDaemon(true);
        writerThread.start();

        sweeperThread = new Thread(this::sweeperLoop, "MineBuddy-Sweeper");
        sweeperThread.setDaemon(true);
        sweeperThread.start();
    }

    public int clientCount() {
        return clients.size();
    }

    /** Публикация события. Не блокирует: при переполнении старое событие выбрасывается. */
    public void emit(String json) {
        if (json == null || json.isEmpty()) return;
        if (!outbound.offer(json)) {
            // очередь переполнена — значит клиент не читает, роняем самое старое
            outbound.poll();
            outbound.offer(json);
        }
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try {
                Socket socket = server.accept();
                socket.setTcpNoDelay(true);
                socket.setKeepAlive(true);

                // принимаем только локальные подключения
                if (!socket.getInetAddress().isLoopbackAddress()) {
                    socket.close();
                    continue;
                }

                String id = "c" + clientSeq.incrementAndGet();
                Client client = new Client(id, socket);
                clients.put(id, client);

                if (MineBuddyMod.LOG.isDebugEnabled()) {
                    MineBuddyMod.LOG.debug("[MineBuddy] Клиент {} подключён", id);
                }

                // приветственный пакет, чтобы приложение поняло, кто на связи
                client.writer.write("{\"type\":\"hello\",\"mod\":\"minebuddy-bridge\",\"version\":\""
                        + MineBuddyMod.VERSION + "\"}\n");
                client.writer.flush();
            } catch (IOException e) {
                if (!server.isClosed()) {
                    MineBuddyMod.LOG.warn("[MineBuddy] Ошибка accept", e);
                }
            }
        }
    }

    private void writerLoop() {
        while (true) {
            String line;
            try {
                line = outbound.poll(1, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (line == null) continue;

            for (Client c : clients.values()) {
                try {
                    c.writer.write(line);
                    c.writer.write('\n');
                    c.writer.flush();
                    c.failures = 0;
                } catch (IOException e) {
                    if (++c.failures >= MAX_WRITE_FAILURES) {
                        dropClient(c);
                    }
                }
            }
        }
    }

    private void sweeperLoop() {
        while (true) {
            try {
                Thread.sleep(SWEEP_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            for (Client c : List.copyOf(clients.values())) {
                if (c.socket.isClosed() || !c.socket.isConnected()) {
                    dropClient(c);
                }
            }
        }
    }

    private void dropClient(Client c) {
        clients.remove(c.id);
        try {
            c.writer.close();
            c.socket.close();
        } catch (IOException ignored) {
        }
        if (MineBuddyMod.LOG.isDebugEnabled()) {
            MineBuddyMod.LOG.debug("[MineBuddy] Клиент {} отключён", c.id);
        }
    }

    private static final class Client {
        final String id;
        final Socket socket;
        final BufferedWriter writer;
        int failures = 0;

        Client(String id, Socket socket) throws IOException {
            this.id = id;
            this.socket = socket;
            this.writer = new BufferedWriter(
                    new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8), 8192);
        }
    }
}
