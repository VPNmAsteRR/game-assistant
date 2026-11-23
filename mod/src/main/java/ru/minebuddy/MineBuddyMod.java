package ru.minebuddy;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MineBuddy Bridge — клиентская часть.
 *
 * Мод ничего не рисует и не трогает геймплей. Его задача — собирать
 * игровые события и отдавать их десктоп-приложению по TCP (NDJSON).
 *
 * Связь строго локальная (127.0.0.1), наружу ничего не уходит.
 */
public class MineBuddyMod implements ClientModInitializer {
    public static final String MOD_ID = "minebuddy";
    public static final String VERSION = "1.0.0";
    public static final Logger LOG = LoggerFactory.getLogger("MineBuddy");

    private static BridgeServer bridge;
    private static EventCollector collector;

    @Override
    public void onInitializeClient() {
        BridgeConfig config = BridgeConfig.load();

        bridge = new BridgeServer(config);
        collector = new EventCollector(bridge, config);

        bridge.start();
        collector.register();

        LOG.info("[MineBuddy] Мост запущен на 127.0.0.1:{} (снимок каждые {} тиков)",
                config.port, config.tickInterval);
    }

    public static BridgeServer bridge() {
        return bridge;
    }

    public static EventCollector collector() {
        return collector;
    }
}
