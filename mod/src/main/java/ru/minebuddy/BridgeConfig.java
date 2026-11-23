package ru.minebuddy;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import net.fabricmc.loader.api.FabricLoader;

/**
 * Конфиг мода: minebuddy/config.json в папке игры.
 *
 * Намеренно простой — без сторонних библиотек, чтобы не тянуть лишнее.
 */
public final class BridgeConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /** Порт локального TCP-моста. */
    public int port = 47821;

    /** Как часто отправлять снимок состояния мира (в игровых тиках, 20 тиков = 1 сек). */
    public int tickInterval = 10;

    /** Отправлять ли координаты игрока. Можно выключить для приватности. */
    public boolean sharePosition = true;

    /** Отправлять ли инвентарь и экипировку. */
    public boolean shareInventory = true;

    /** Отправлять ли состояние здоровья/голода/опыта. */
    public boolean shareVitals = true;

    /** Отправлять ли события (смерть, урон, находки, достижения). */
    public boolean shareEvents = true;

    /** Включать ли события мобов рядом (для подсказок «крипер сзади»). */
    public boolean mobRadar = true;

    /** Радиус сканирования мобов, в блоках. */
    public double mobRadius = 16.0;

    /** Вербозный лог в консоль (для отладки). */
    public boolean debug = false;

    public static BridgeConfig load() {
        Path dir = FabricLoader.getInstance().getConfigDir().resolve("minebuddy");
        Path file = dir.resolve("config.json");
        try {
            if (Files.exists(file)) {
                String json = Files.readString(file, StandardCharsets.UTF_8);
                BridgeConfig cfg = GSON.fromJson(json, BridgeConfig.class);
                if (cfg != null) {
                    cfg.clamp();
                    return cfg;
                }
            }
            BridgeConfig def = new BridgeConfig();
            Files.createDirectories(dir);
            Files.writeString(file, GSON.toJson(def), StandardCharsets.UTF_8);
            return def;
        } catch (IOException e) {
            MineBuddyMod.LOG.warn("[MineBuddy] Не удалось прочитать конфиг, использую значения по умолчанию", e);
            return new BridgeConfig();
        }
    }

    private void clamp() {
        if (port < 1024 || port > 65535) port = 47821;
        if (tickInterval < 1) tickInterval = 1;
        if (tickInterval > 200) tickInterval = 200;
        if (mobRadius < 1) mobRadius = 1;
        if (mobRadius > 64) mobRadius = 64;
    }
}
