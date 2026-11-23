package ru.minebuddy;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.event.player.AttackBlockCallback;
import net.fabricmc.fabric.api.event.player.AttackEntityCallback;
import net.minecraft.block.Block;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.entity.passive.PassiveEntity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.scoreboard.Scoreboard;
import net.minecraft.scoreboard.ScoreboardObjective;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

/**
 * Собирает события Minecraft и отдаёт их в BridgeServer.
 *
 * Важно: всё выполняется в игровом потоке, поэтому работа максимально дешёвая —
 * никаких тяжёлых обходов мира каждый тик. Сканирование мобов идёт редко и
 * только по ближайшим сущностям.
 */
public final class EventCollector {
    private static final Gson GSON = new GsonBuilder().create();
    private static final String TYPE_SNAPSHOT = "snapshot";
    private static final String TYPE_EVENT = "event";

    private final BridgeServer bridge;
    private final BridgeConfig config;

    private int tickCounter = 0;
    private int fastCounter = 0;

    // предыдущее состояние для детекта изменений
    private float lastHealth = -1f;
    private int lastHunger = -1;
    private int lastXpLevel = -1;
    private String lastDimension = "";
    private boolean wasOnGround = true;
    private int deathCooldown = 0;
    private int joinCooldown = 0;

    // антиспам для событий
    private long lastMobWarnAt = 0;
    private String lastMobWarnKey = "";

    public EventCollector(BridgeServer bridge, BridgeConfig config) {
        this.bridge = bridge;
        this.config = config;
    }

    public void register() {
        ClientTickEvents.END_CLIENT_TICK.register(this::onTick);
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> onJoin());
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> onDisconnect());

        AttackBlockCallback.EVENT.register((player, world, hand, pos, direction) -> {
            if (world.isClient() && player == MinecraftClient.getInstance().player) {
                onBlockAttack(world, pos);
            }
            return ActionResult.PASS;
        });

        AttackEntityCallback.EVENT.register((player, world, hand, entity, hitResult) -> {
            if (world.isClient() && player == MinecraftClient.getInstance().player) {
                onEntityAttack(entity);
            }
            return ActionResult.PASS;
        });
    }

    /* ------------------------------------------------------------ */

    private void onJoin() {
        joinCooldown = 40; // полсекунды, чтобы мир успел прогрузиться
        lastHealth = -1f;
        lastHunger = -1;
        lastXpLevel = -1;
        lastDimension = "";
        emitEvent("join", "Мир загружен", null, null);
    }

    private void onDisconnect() {
        emitEvent("leave", "Игрок вышел из мира", null, null);
    }

    private void onTick(MinecraftClient client) {
        if (client.player == null || client.world == null) return;

        if (joinCooldown > 0) {
            joinCooldown--;
            return;
        }

        // антиспам-таймеры
        if (deathCooldown > 0) deathCooldown--;

        ClientPlayerEntity player = client.player;
        World world = client.world;

        // ---- быстрые проверки каждый тик: дёшево ----
        checkVitals(player, world);
        checkMovement(player);

        // ---- снимок состояния раз в N тиков ----
        tickCounter++;
        if (tickCounter >= Math.max(1, config.tickInterval)) {
            tickCounter = 0;
            sendSnapshot(player, world);
        }

        // ---- радар мобов раз в секунду (20 тиков) ----
        fastCounter++;
        if (fastCounter >= 20) {
            fastCounter = 0;
            if (config.mobRadar) scanMobs(player, world);
        }
    }

    /* ------------------------------------------------------------ */
    /* быстрые проверки                                              */
    /* ------------------------------------------------------------ */

    private void checkVitals(ClientPlayerEntity player, World world) {
        if (!config.shareVitals) return;

        float health = player.getHealth();
        int hunger = player.getHungerManager().getFoodLevel();
        int xp = player.experienceLevel;

        if (lastHealth >= 0 && health < lastHealth - 0.5f) {
            float delta = lastHealth - health;
            emitEvent("damage", "Игрок получил урон: -" + fmt(delta),
                    "health", fmt(health));
        }

        if (lastHealth >= 0 && health <= 0 && deathCooldown == 0) {
            deathCooldown = 100;
            emitEvent("death", "Игрок умер", null, null);
        }

        if (lastHunger >= 0 && hunger < lastHunger && hunger <= 6) {
            emitEvent("hunger", "Голод на исходе: " + hunger + "/20", null, null);
        }

        if (lastXpLevel >= 0 && xp > lastXpLevel) {
            emitEvent("xp", "Новый уровень: " + xp, null, null);
        }

        String dim = world.getRegistryKey().getValue().toString();
        if (!lastDimension.isEmpty() && !lastDimension.equals(dim)) {
            emitEvent("dimension", "Измерение: " + prettyDimension(dim), null, null);
        }

        lastHealth = health;
        lastHunger = hunger;
        lastXpLevel = xp;
        lastDimension = dim;
    }

    private void checkMovement(ClientPlayerEntity player) {
        boolean onGround = player.isOnGround();
        if (wasOnGround && !onGround && player.getVelocity().y > 0.42) {
            emitEvent("jump", "Прыжок", null, null);
        }
        wasOnGround = onGround;
    }

    /* ------------------------------------------------------------ */
    /* снимок состояния                                             */
    /* ------------------------------------------------------------ */

    private void sendSnapshot(ClientPlayerEntity player, World world) {
        JsonObject o = new JsonObject();
        o.addProperty("type", TYPE_SNAPSHOT);
        o.addProperty("t", System.currentTimeMillis());

        o.addProperty("player", player.getGameProfile().getName());
        o.addProperty("health", fmt(player.getHealth()));
        o.addProperty("maxHealth", fmt(player.getMaxHealth()));
        o.addProperty("hunger", player.getHungerManager().getFoodLevel());
        o.addProperty("xpLevel", player.experienceLevel);
        o.addProperty("xpProgress", fmt(player.experienceProgress));
        o.addProperty("dimension", world.getRegistryKey().getValue().toString());
        var im = MinecraftClient.getInstance().interactionManager;
        o.addProperty("gameMode", im != null ? im.getCurrentGameMode().getName() : "unknown");
        o.addProperty("onGround", player.isOnGround());
        o.addProperty("sneaking", player.isSneaking());
        o.addProperty("sprinting", player.isSprinting());

        if (config.sharePosition) {
            o.addProperty("x", fmt(player.getX()));
            o.addProperty("y", fmt(player.getY()));
            o.addProperty("z", fmt(player.getZ()));
            o.addProperty("yaw", fmt(player.getYaw()));
        }

        o.addProperty("time", world.getTimeOfDay());
        o.addProperty("raining", world.isRaining());
        o.addProperty("thundering", world.isThundering());

        if (config.shareInventory) {
            o.add("inventory", inventoryJson(player));
            o.add("armor", armorJson(player));
        }

        if (config.mobRadar) {
            o.add("mobs", mobsJson(player, world));
        }

        bridge.emit(GSON.toJson(o));
    }

    private JsonArray inventoryJson(ClientPlayerEntity player) {
        JsonArray arr = new JsonArray();
        var inv = player.getInventory();
        // только хотбар: 0..8, остальное неинтересно помощнику
        for (int i = 0; i < 9; i++) {
            ItemStack stack = inv.getStack(i);
            if (stack.isEmpty()) continue;
            JsonObject it = new JsonObject();
            it.addProperty("slot", i);
            it.addProperty("id", Registries.ITEM.getId(stack.getItem()).toString());
            it.addProperty("count", stack.getCount());
            it.addProperty("name", stack.getName().getString());
            if (i == inv.selectedSlot) it.addProperty("selected", true);
            arr.add(it);
        }
        return arr;
    }

    private JsonArray armorJson(ClientPlayerEntity player) {
        JsonArray arr = new JsonArray();
        var inv = player.getInventory();
        String[] slots = {"feet", "legs", "chest", "head"};
        for (int i = 0; i < 4; i++) {
            ItemStack stack = inv.getArmorStack(i);
            if (stack.isEmpty()) continue;
            JsonObject it = new JsonObject();
            it.addProperty("slot", slots[i]);
            it.addProperty("id", Registries.ITEM.getId(stack.getItem()).toString());
            it.addProperty("name", stack.getName().getString());
            arr.add(it);
        }
        return arr;
    }

    private JsonArray mobsJson(ClientPlayerEntity player, World world) {
        JsonArray arr = new JsonArray();
        double r = config.mobRadius;
        double r2 = r * r;

        // getEntitiesByClass с фильтром по дистанции: сервер сам сужает выборку
        List<Entity> found = new ArrayList<>();
        for (Entity e : world.getEntitiesByClass(Entity.class, player.getBoundingBox().expand(r), ent -> ent != player)) {
            if (e.squaredDistanceTo(player) > r2) continue;
            if (!(e instanceof LivingEntity living)) continue;
            if (!living.isAlive()) continue;
            found.add(e);
            if (found.size() >= 24) break; // ограничение, чтобы не раздувать пакет
        }

        for (Entity e : found) {
            JsonObject m = new JsonObject();
            String name = e.getType().getName().getString();
            m.addProperty("name", name);
            m.addProperty("id", Registries.ENTITY_TYPE.getId(e.getType()).toString());
            m.addProperty("hostile", e instanceof HostileEntity);
            m.addProperty("x", fmt(e.getX()));
            m.addProperty("y", fmt(e.getY()));
            m.addProperty("z", fmt(e.getZ()));
            m.addProperty("distance", fmt(Math.sqrt(e.squaredDistanceTo(player))));
            arr.add(m);
        }
        return arr;
    }

    /* ------------------------------------------------------------ */
    /* события действий                                             */
    /* ------------------------------------------------------------ */

    private void onBlockAttack(World world, BlockPos pos) {
        Block block = world.getBlockState(pos).getBlock();
        String id = Registries.BLOCK.getId(block).toString();

        if (id.endsWith("_ore")) {
            emitEvent("mine_ore", "Игрок начал добывать руду: " + block.getName().getString(),
                    "block", id);
        }
    }

    private void onEntityAttack(Entity entity) {
        if (entity instanceof HostileEntity) {
            emitEvent("attack_mob", "Атака моба: " + entity.getType().getName().getString(),
                    "entity", Registries.ENTITY_TYPE.getId(entity.getType()).toString());
        } else if (entity instanceof PassiveEntity) {
            emitEvent("attack_animal", "Атака животного: " + entity.getType().getName().getString(),
                    "entity", Registries.ENTITY_TYPE.getId(entity.getType()).toString());
        } else if (entity instanceof PlayerEntity p && p != MinecraftClient.getInstance().player) {
            emitEvent("attack_player", "Атака игрока: " + p.getGameProfile().getName(), null, null);
        }
    }

    private void scanMobs(ClientPlayerEntity player, World world) {
        double r = config.mobRadius;
        double r2 = r * r;
        Entity closest = null;
        double closestDist = Double.MAX_VALUE;

        for (Entity e : world.getEntitiesByClass(Entity.class, player.getBoundingBox().expand(r), ent -> ent != player)) {
            if (!(e instanceof HostileEntity)) continue;
            double d2 = e.squaredDistanceTo(player);
            if (d2 <= r2 && d2 < closestDist) {
                closestDist = d2;
                closest = e;
            }
        }

        if (closest == null) {
            lastMobWarnKey = "";
            return;
        }

        String key = Registries.ENTITY_TYPE.getId(closest.getType()).toString();
        long now = System.currentTimeMillis();

        // не чаще раза в 4 секунды и только на смену типа моба
        if (key.equals(lastMobWarnKey) && now - lastMobWarnAt < 4000) return;

        lastMobWarnKey = key;
        lastMobWarnAt = now;

        emitEvent("mob_near", "Рядом опасный моб: " + closest.getType().getName().getString()
                        + " (" + fmt(Math.sqrt(closestDist)) + " м)",
                "entity", key);
    }

    /* ------------------------------------------------------------ */
    /* утилиты                                                      */
    /* ------------------------------------------------------------ */

    private void emitEvent(String kind, String message, String key, String value) {
        if (!config.shareEvents && !kind.equals("join") && !kind.equals("leave")) return;

        JsonObject o = new JsonObject();
        o.addProperty("type", TYPE_EVENT);
        o.addProperty("t", System.currentTimeMillis());
        o.addProperty("kind", kind);
        o.addProperty("message", message);
        if (key != null) o.addProperty("key", key);
        if (value != null) o.addProperty("value", value);
        bridge.emit(GSON.toJson(o));
    }

    private static String fmt(double v) {
        return String.format(java.util.Locale.ROOT, "%.2f", v);
    }

    private static String prettyDimension(String id) {
        if (id.endsWith("overworld")) return "Верхний мир";
        if (id.endsWith("the_nether")) return "Нижний мир";
        if (id.endsWith("the_end")) return "Край";
        return id;
    }
}
