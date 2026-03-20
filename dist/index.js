import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActivityType, } from "discord.js";
import { config as cfg } from "./config.js";
// ─── STORAGE ─────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.resolve(__dirname, "..", cfg.dbPath);
function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const empty = { guilds: {}, sessions: {} };
        fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
        fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
        return empty;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}
function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function getGuild(guildId) {
    const db = loadDB();
    if (!db.guilds[guildId]) {
        db.guilds[guildId] = {
            questions: [],
            cooldownHours: cfg.defaultCooldownHours,
            applications: {},
            cooldowns: {},
            pendingApplications: {},
            applicationCounter: 0,
        };
        saveDB(db);
    }
    return db.guilds[guildId];
}
function saveGuild(guildId, g) {
    const db = loadDB();
    db.guilds[guildId] = g;
    saveDB(db);
}
function getSession(userId) {
    return loadDB().sessions[userId];
}
function setSession(userId, s) {
    const db = loadDB();
    db.sessions[userId] = s;
    saveDB(db);
}
function deleteSession(userId) {
    const db = loadDB();
    delete db.sessions[userId];
    saveDB(db);
}
// ─── EMOJI HELPERS ───────────────────────────────────────────────────────────
// الصيغ المدعومة في config.ts:
//   "📝"                          ← إيموجي عادي (يونيكود)
//   "apply:1234567890123456789"   ← إيموجي خارجي
//   "a:apply:1234567890123456789" ← إيموجي خارجي متحرك (animated)
// يحول النص لكائن يفهمه Discord.js للأزرار
function resolveEmoji(str) {
    // animated: "a:name:ID"
    const animMatch = str.match(/^a:(\w+):(\d+)$/);
    if (animMatch)
        return { animated: true, name: animMatch[1], id: animMatch[2] };
    // static custom: "name:ID"
    const customMatch = str.match(/^(\w+):(\d+)$/);
    if (customMatch)
        return { name: customMatch[1], id: customMatch[2] };
    // full Discord mention <:name:ID> or <a:name:ID>
    const mentionMatch = str.match(/^<(a?):(\w+):(\d+)>$/);
    if (mentionMatch)
        return { animated: mentionMatch[1] === "a", name: mentionMatch[2], id: mentionMatch[3] };
    // pure numeric ID — يبحث عن الإيموجي في كاش البوت
    const idOnly = str.match(/^\d{10,}$/);
    if (idOnly) {
        const found = client.emojis.cache.get(str);
        if (found)
            return { id: str, name: found.name ?? "e", animated: found.animated ?? false };
        return { id: str, name: "e" };
    }
    // plain unicode
    return str;
}
// يحول النص لصيغة عرض في الإيمبدات
function emojiText(str) {
    const animMatch = str.match(/^a:(\w+):(\d+)$/);
    if (animMatch)
        return `<a:${animMatch[1]}:${animMatch[2]}>`;
    const customMatch = str.match(/^(\w+):(\d+)$/);
    if (customMatch)
        return `<:${customMatch[1]}:${customMatch[2]}>`;
    const mentionMatch = str.match(/^<(a?):(\w+):(\d+)>$/);
    if (mentionMatch)
        return str;
    // pure numeric ID — يبحث عن الإيموجي في كاش البوت
    const idOnly = str.match(/^\d{10,}$/);
    if (idOnly) {
        const found = client.emojis.cache.get(str);
        if (found)
            return found.animated ? `<a:${found.name}:${str}>` : `<:${found.name}:${str}>`;
        return `<:e:${str}>`;
    }
    return str;
}
const e = cfg.emojis;
// يرجع نصوص اللوحة: تعديلات السيرفر أولاً ثم الافتراضي من config
function getPanelText(g) {
    return {
        title: g.panelText?.title ?? cfg.text.panelTitle,
        description: g.panelText?.description ?? cfg.text.panelDescription,
        footer: g.panelText?.footer ?? cfg.text.panelFooter,
        buttonLabel: g.panelText?.buttonLabel ?? "تقديم الآن",
    };
}
// ─── BOT SETUP ───────────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token) {
    console.error("❌ DISCORD_TOKEN مش موجود!");
    process.exit(1);
}
if (!clientId) {
    console.error("❌ DISCORD_CLIENT_ID مش موجود!");
    process.exit(1);
}
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message],
});
// ─── DEPLOY COMMANDS ─────────────────────────────────────────────────────────
const panelCommand = new SlashCommandBuilder()
    .setName("panel")
    .setDescription("لوحة تحكم البوت")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
async function deployCommands() {
    const rest = new REST().setToken(token);
    await rest.put(Routes.applicationCommands(clientId), {
        body: [panelCommand.toJSON()],
    });
    console.log("✅ تم نشر الأوامر!");
}
// ─── EVENTS ──────────────────────────────────────────────────────────────────
client.once("clientReady", async () => {
    console.log(`✅ البوت شغال كـ ${client.user?.tag}`);
    console.log(`📊 موجود في ${client.guilds.cache.size} سيرفر`);
    client.user?.setPresence({
        activities: [{ name: "/panel", type: ActivityType.Playing }],
        status: "online",
    });
    await deployCommands();
});
client.on("messageCreate", async (message) => {
    if (message.author.bot || message.guild)
        return;
    const session = getSession(message.author.id);
    if (!session)
        return;
    const guild = getGuild(session.guildId);
    const app = guild.applications[session.appId];
    if (!app) {
        deleteSession(message.author.id);
        return;
    }
    const answer = message.content.trim();
    if (!answer) {
        await message.reply("❌ اكتب إجابة صحيحة.");
        return;
    }
    app.answers[session.step] = answer;
    const next = session.step + 1;
    const dmChannel = message.channel;
    if (next < app.questions.length) {
        setSession(message.author.id, { ...session, step: next });
        await dmChannel.send({
            embeds: [new EmbedBuilder().setColor(0x5865f2)
                    .setDescription(`✅ تم تسجيل إجابتك!\n\n**سؤال ${next + 1} من ${app.questions.length}:**\n${app.questions[next]}`)
                    .setFooter({ text: cfg.text.dmFooter })],
        });
    }
    else {
        app.status = "pending";
        guild.applications[session.appId] = app;
        saveGuild(session.guildId, guild);
        deleteSession(message.author.id);
        await dmChannel.send({
            embeds: [new EmbedBuilder().setColor(0x57f287)
                    .setTitle("✅ تم إرسال طلبك!")
                    .setDescription("شكراً! سيتم مراجعة طلبك وإخطارك بالنتيجة قريباً. 🎉")
                    .setTimestamp()],
        });
        if (!guild.logChannelId)
            return;
        const logCh = await client.channels.fetch(guild.logChannelId).catch(() => null);
        if (!logCh?.isTextBased())
            return;
        const { embed, row } = buildApplicationEmbed(app, guild.applicationCounter);
        const msg = await logCh.send({ embeds: [embed], components: [row] });
        app.logMessageId = msg.id;
        app.logChannelId = guild.logChannelId;
        guild.applications[session.appId] = app;
        saveGuild(session.guildId, guild);
    }
});
client.on("interactionCreate", async (interaction) => {
    try {
        if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
            await handlePanelCommand(interaction);
            return;
        }
        if (interaction.isButton()) {
            await handleButton(interaction);
            return;
        }
        if (interaction.isStringSelectMenu()) {
            await handleSelect(interaction);
            return;
        }
        if (interaction.isModalSubmit()) {
            await handleModal(interaction);
            return;
        }
    }
    catch (err) {
        console.error("❌ خطأ:", err);
        if (interaction.isRepliable() && !interaction.replied)
            await interaction.reply({ content: "❌ حدث خطأ!", flags: 64 }).catch(() => { });
    }
});
// ─── /panel COMMAND ───────────────────────────────────────────────────────────
async function handlePanelCommand(interaction) {
    const guildId = interaction.guildId;
    if (!guildId)
        return;
    const g = getGuild(guildId);
    const { embed, rows } = buildAdminPanel(g);
    await interaction.reply({ embeds: [embed], components: rows, flags: 64 });
}
// ─── ADMIN PANEL BUILDER ──────────────────────────────────────────────────────
function buildAdminPanel(g) {
    const embed = new EmbedBuilder()
        .setTitle("⚙️ لوحة تحكم البوت")
        .setColor(0x5865f2)
        .addFields({ name: "📢 قناة التقديم", value: g.applicationChannelId ? `<#${g.applicationChannelId}>` : "_غير محددة_", inline: true }, { name: "📬 قناة السجل", value: g.logChannelId ? `<#${g.logChannelId}>` : "_غير محددة_", inline: true }, { name: "🛡️ رتبة المراجعة", value: g.reviewRoleId ? `<@&${g.reviewRoleId}>` : "_غير محددة_", inline: true }, { name: "⏳ وقت الانتظار", value: `${g.cooldownHours} ساعة`, inline: true }, { name: "❓ الأسئلة", value: `${g.questions.length} سؤال`, inline: true })
        .setFooter({ text: "اضغط على الزر المناسب لتعديل الإعداد" })
        .setTimestamp();
    const row1 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("admin_set_appchannel").setLabel("قناة التقديم").setEmoji("📢").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("admin_set_logchannel").setLabel("قناة السجل").setEmoji("📬").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("admin_set_reviewrole").setLabel("رتبة المراجعة").setEmoji("🛡️").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId("admin_set_cooldown").setLabel("وقت الانتظار").setEmoji("⏳").setStyle(ButtonStyle.Secondary));
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("admin_questions").setLabel("إدارة الأسئلة").setEmoji("❓").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId("admin_panel_text").setLabel("تخصيص اللوحة").setEmoji("✏️").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId("admin_deploy_panel").setLabel("نشر لوحة التقديم").setEmoji("🚀").setStyle(ButtonStyle.Success));
    return { embed, rows: [row1, row2] };
}
// ─── BUTTON HANDLER ───────────────────────────────────────────────────────────
async function handleButton(interaction) {
    const { customId } = interaction;
    const guildId = interaction.guildId;
    if (!guildId)
        return;
    const g = getGuild(guildId);
    // ── Admin panel buttons ──────────────────────────────────────────────────
    if (customId === "admin_set_appchannel") {
        const modal = new ModalBuilder().setCustomId("modal_set_appchannel").setTitle("تعيين قناة التقديم");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("channel_id").setLabel("ID القناة").setStyle(TextInputStyle.Short)
            .setPlaceholder("مثال: 1234567890123456789").setRequired(true)));
        await interaction.showModal(modal);
        return;
    }
    if (customId === "admin_set_logchannel") {
        const modal = new ModalBuilder().setCustomId("modal_set_logchannel").setTitle("تعيين قناة السجل");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("channel_id").setLabel("ID القناة").setStyle(TextInputStyle.Short)
            .setPlaceholder("مثال: 1234567890123456789").setRequired(true)));
        await interaction.showModal(modal);
        return;
    }
    if (customId === "admin_set_reviewrole") {
        const modal = new ModalBuilder().setCustomId("modal_set_reviewrole").setTitle("تعيين رتبة المراجعة");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("role_id").setLabel("ID الرتبة").setStyle(TextInputStyle.Short)
            .setPlaceholder("مثال: 1234567890123456789").setRequired(true)));
        await interaction.showModal(modal);
        return;
    }
    if (customId === "admin_set_cooldown") {
        const modal = new ModalBuilder().setCustomId("modal_set_cooldown").setTitle("تعيين وقت الانتظار");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("hours").setLabel("عدد الساعات (1 - 720)").setStyle(TextInputStyle.Short)
            .setValue(String(g.cooldownHours)).setRequired(true)));
        await interaction.showModal(modal);
        return;
    }
    if (customId === "admin_questions") {
        await interaction.reply({
            embeds: [buildQuestionsStatusEmbed(g)],
            components: [buildQuestionsRow(g.questions)],
            flags: 64,
        });
        return;
    }
    if (customId === "admin_panel_text") {
        const pt = getPanelText(g);
        const modal = new ModalBuilder().setCustomId("modal_panel_text").setTitle("تخصيص لوحة التقديم");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("عنوان اللوحة").setStyle(TextInputStyle.Short)
            .setValue(pt.title).setRequired(true).setMaxLength(100)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("description").setLabel("وصف اللوحة").setStyle(TextInputStyle.Paragraph)
            .setValue(pt.description).setRequired(true).setMaxLength(2000)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("footer").setLabel("تذييل اللوحة (Footer)").setStyle(TextInputStyle.Short)
            .setValue(pt.footer).setRequired(false).setMaxLength(100)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("buttonLabel").setLabel("نص زرار التقديم").setStyle(TextInputStyle.Short)
            .setValue(pt.buttonLabel).setRequired(false).setMaxLength(80)));
        await interaction.showModal(modal);
        return;
    }
    if (customId === "admin_deploy_panel") {
        const modal = new ModalBuilder().setCustomId("modal_deploy_panel").setTitle("نشر لوحة التقديم");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("channel_id").setLabel("ID القناة التي ستُنشر فيها اللوحة").setStyle(TextInputStyle.Short)
            .setPlaceholder("مثال: 1234567890123456789")
            .setValue(g.applicationChannelId ?? "").setRequired(true)));
        await interaction.showModal(modal);
        return;
    }
    // ── Questions management buttons ─────────────────────────────────────────
    if (customId === "q_add") {
        if (g.questions.length >= cfg.maxQuestions) {
            await interaction.reply({ content: `❌ الحد الأقصى ${cfg.maxQuestions} أسئلة!`, flags: 64 });
            return;
        }
        const modal = new ModalBuilder().setCustomId("modal_add_q").setTitle("إضافة سؤال جديد");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("q_text").setLabel("نص السؤال").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(200)));
        await interaction.showModal(modal);
        return;
    }
    if (customId === "q_edit" || customId === "q_remove") {
        if (g.questions.length === 0) {
            await interaction.reply({ content: "❌ لا توجد أسئلة!", flags: 64 });
            return;
        }
        const select = new StringSelectMenuBuilder()
            .setCustomId(customId === "q_edit" ? "sel_edit_q" : "sel_remove_q")
            .setPlaceholder("اختر السؤال")
            .addOptions(g.questions.map((q, i) => new StringSelectMenuOptionBuilder().setLabel(`${i + 1}. ${q.substring(0, 50)}`).setValue(String(i))));
        await interaction.reply({
            content: "اختر السؤال:",
            components: [new ActionRowBuilder().addComponents(select)],
            flags: 64,
        });
        return;
    }
    if (customId === "q_clear") {
        g.questions = [];
        saveGuild(guildId, g);
        await interaction.update({ content: "✅ تم حذف جميع الأسئلة!", embeds: [], components: [] });
        return;
    }
    // ── Application review buttons ───────────────────────────────────────────
    if (customId.startsWith("app_accept_")) {
        if (!await checkReviewer(interaction, g))
            return;
        const appId = customId.replace("app_accept_", "");
        const app = g.applications[appId];
        if (!app) {
            await interaction.reply({ content: "❌ الطلب غير موجود!", flags: 64 });
            return;
        }
        if (app.status !== "pending") {
            await interaction.reply({ content: "⚠️ تمت مراجعة هذا الطلب بالفعل!", flags: 64 });
            return;
        }
        app.status = "accepted";
        app.reviewedBy = interaction.user.id;
        delete g.pendingApplications[app.userId];
        g.applications[appId] = app;
        saveGuild(guildId, g);
        await updateLogMessage(app, "✅ مقبول", 0x57f287);
        try {
            const reviewer = await interaction.guild.members.fetch(interaction.user.id);
            const applicant = await client.users.fetch(app.userId);
            await applicant.send({
                embeds: [new EmbedBuilder().setColor(0x57f287)
                        .setTitle(`${emojiText(e.accept)} تم قبول طلبك!`)
                        .setDescription(cfg.text.acceptMsg)
                        .addFields({ name: "راجعه", value: `<@${reviewer.id}>`, inline: true })
                        .setTimestamp()],
            });
        }
        catch { }
        await interaction.reply({ content: "✅ تم قبول الطلب وإخطار المتقدم.", flags: 64 });
        return;
    }
    if (customId.startsWith("app_reject_")) {
        if (!await checkReviewer(interaction, g))
            return;
        const appId = customId.replace("app_reject_", "");
        const app = g.applications[appId];
        if (!app) {
            await interaction.reply({ content: "❌ الطلب غير موجود!", flags: 64 });
            return;
        }
        if (app.status !== "pending") {
            await interaction.reply({ content: "⚠️ تمت مراجعة هذا الطلب بالفعل!", flags: 64 });
            return;
        }
        const modal = new ModalBuilder().setCustomId(`modal_reject_${appId}`).setTitle("سبب الرفض");
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("سبب الرفض").setStyle(TextInputStyle.Paragraph)
            .setRequired(true).setMaxLength(500).setPlaceholder("اكتب السبب هنا...")));
        await interaction.showModal(modal);
        return;
    }
    if (customId.startsWith("app_info_")) {
        const appId = customId.replace("app_info_", "");
        const app = g.applications[appId];
        if (!app) {
            await interaction.reply({ content: "❌ الطلب غير موجود!", flags: 64 });
            return;
        }
        await interaction.reply({
            embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("ℹ️ معلومات المتقدم")
                    .addFields({ name: "الاسم", value: app.username, inline: true }, { name: "ID", value: app.userId, inline: true }, { name: "إنشاء الحساب", value: app.accountCreated, inline: true }, { name: "الانضمام", value: app.joinedServer, inline: true }, { name: "الحالة", value: app.status === "pending" ? "⏳ قيد المراجعة" : app.status === "accepted" ? "✅ مقبول" : "❌ مرفوض", inline: true })],
            flags: 64,
        });
        return;
    }
    // ── Apply start (user button on panel) ──────────────────────────────────
    if (customId === "apply_start") {
        if (g.questions.length === 0) {
            await interaction.reply({ content: "❌ لم يتم تعيين أسئلة بعد!", flags: 64 });
            return;
        }
        if (!g.logChannelId) {
            await interaction.reply({ content: "❌ لم يتم تعيين قناة السجل بعد!", flags: 64 });
            return;
        }
        const userId = interaction.user.id;
        if (g.pendingApplications[userId]) {
            await interaction.reply({ content: "⏳ لديك طلب قيد المراجعة بالفعل!", flags: 64 });
            return;
        }
        if (g.cooldowns[userId] && Date.now() < g.cooldowns[userId]) {
            const h = Math.ceil((g.cooldowns[userId] - Date.now()) / 3600000);
            await interaction.reply({ content: `⏳ انتظر **${h} ساعة** قبل التقديم مجدداً.`, flags: 64 });
            return;
        }
        let member = null;
        try {
            member = await interaction.guild.members.fetch(userId);
        }
        catch { }
        const appId = randomUUID();
        g.applicationCounter = (g.applicationCounter || 0) + 1;
        g.applications[appId] = {
            id: appId, userId, username: interaction.user.tag,
            userAvatar: interaction.user.displayAvatarURL(),
            accountCreated: `<t:${Math.floor(interaction.user.createdTimestamp / 1000)}:D>`,
            joinedServer: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : "غير معروف",
            questions: [...g.questions], answers: [], status: "pending",
            appliedAt: new Date().toISOString(),
        };
        g.pendingApplications[userId] = appId;
        saveGuild(guildId, g);
        setSession(userId, { guildId, appId, step: 0 });
        try {
            const dm = await interaction.user.createDM();
            await dm.send({
                embeds: [new EmbedBuilder().setColor(0x5865f2)
                        .setTitle("📋 طلب تقديم في الإدارة")
                        .setDescription(`مرحباً **${interaction.user.username}**!\n\nسيتم طرح **${g.questions.length} سؤال** عليك واحد تلو الآخر.\n\n**سؤال 1 من ${g.questions.length}:**\n${g.questions[0]}`)
                        .setFooter({ text: cfg.text.dmFooter }).setTimestamp()],
            });
            await interaction.reply({ content: "✅ تم إرسال الأسئلة في الرسائل الخاصة!", flags: 64 });
        }
        catch {
            delete g.applications[appId];
            delete g.pendingApplications[userId];
            saveGuild(guildId, g);
            deleteSession(userId);
            await interaction.reply({ content: "❌ لا يمكن إرسال رسالة خاصة! افتح الـ DM وحاول مجدداً.", flags: 64 });
        }
    }
}
// ─── SELECT HANDLER ───────────────────────────────────────────────────────────
async function handleSelect(interaction) {
    const { customId } = interaction;
    const guildId = interaction.guildId;
    if (!guildId)
        return;
    const g = getGuild(guildId);
    if (customId === "sel_remove_q") {
        const i = parseInt(interaction.values[0]);
        const removed = g.questions.splice(i, 1)[0];
        saveGuild(guildId, g);
        await interaction.update({ content: `✅ تم حذف: **${removed}**`, components: [] });
        return;
    }
    if (customId === "sel_edit_q") {
        const i = parseInt(interaction.values[0]);
        const modal = new ModalBuilder().setCustomId(`modal_edit_q_${i}`).setTitle(`تعديل السؤال ${i + 1}`);
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("q_text").setLabel("نص السؤال الجديد").setStyle(TextInputStyle.Paragraph)
            .setValue(g.questions[i]).setRequired(true).setMaxLength(200)));
        await interaction.showModal(modal);
    }
}
// ─── MODAL HANDLER ───────────────────────────────────────────────────────────
async function handleModal(interaction) {
    const { customId } = interaction;
    const guildId = interaction.guildId;
    if (!guildId)
        return;
    const g = getGuild(guildId);
    if (customId === "modal_set_appchannel") {
        const id = interaction.fields.getTextInputValue("channel_id").trim();
        const ch = await client.channels.fetch(id).catch(() => null);
        if (!ch?.isTextBased()) {
            await interaction.reply({ content: "❌ ID القناة غير صحيح أو البوت ليس لديه وصول!", flags: 64 });
            return;
        }
        g.applicationChannelId = id;
        saveGuild(guildId, g);
        await interaction.reply({ content: `✅ تم تعيين قناة التقديم: <#${id}>`, flags: 64 });
        return;
    }
    if (customId === "modal_set_logchannel") {
        const id = interaction.fields.getTextInputValue("channel_id").trim();
        const ch = await client.channels.fetch(id).catch(() => null);
        if (!ch?.isTextBased()) {
            await interaction.reply({ content: "❌ ID القناة غير صحيح أو البوت ليس لديه وصول!", flags: 64 });
            return;
        }
        g.logChannelId = id;
        saveGuild(guildId, g);
        await interaction.reply({ content: `✅ تم تعيين قناة السجل: <#${id}>`, flags: 64 });
        return;
    }
    if (customId === "modal_set_reviewrole") {
        const id = interaction.fields.getTextInputValue("role_id").trim();
        const role = interaction.guild?.roles.cache.get(id) ?? await interaction.guild?.roles.fetch(id).catch(() => null);
        if (!role) {
            await interaction.reply({ content: "❌ ID الرتبة غير صحيح!", flags: 64 });
            return;
        }
        g.reviewRoleId = id;
        saveGuild(guildId, g);
        await interaction.reply({ content: `✅ تم تعيين رتبة المراجعة: <@&${id}>`, flags: 64 });
        return;
    }
    if (customId === "modal_set_cooldown") {
        const hours = parseInt(interaction.fields.getTextInputValue("hours").trim());
        if (isNaN(hours) || hours < 1 || hours > 720) {
            await interaction.reply({ content: "❌ أدخل رقم بين 1 و 720!", flags: 64 });
            return;
        }
        g.cooldownHours = hours;
        saveGuild(guildId, g);
        await interaction.reply({ content: `✅ تم تعيين وقت الانتظار: **${hours} ساعة**`, flags: 64 });
        return;
    }
    if (customId === "modal_panel_text") {
        if (!g.panelText)
            g.panelText = {};
        const title = interaction.fields.getTextInputValue("title").trim();
        const description = interaction.fields.getTextInputValue("description").trim();
        const footer = interaction.fields.getTextInputValue("footer").trim();
        const buttonLabel = interaction.fields.getTextInputValue("buttonLabel").trim();
        if (title)
            g.panelText.title = title;
        if (description)
            g.panelText.description = description;
        if (footer)
            g.panelText.footer = footer;
        if (buttonLabel)
            g.panelText.buttonLabel = buttonLabel;
        saveGuild(guildId, g);
        await interaction.reply({
            content: `✅ تم حفظ تخصيص اللوحة!\n\n**العنوان:** ${title}\n**الزرار:** ${buttonLabel || "تقديم الآن"}\n\nاضغط 🚀 **نشر لوحة التقديم** لتطبيق التغييرات.`,
            flags: 64,
        });
        return;
    }
    if (customId === "modal_deploy_panel") {
        const id = interaction.fields.getTextInputValue("channel_id").trim();
        const target = await client.channels.fetch(id).catch(() => null);
        if (!target?.isTextBased()) {
            await interaction.reply({ content: "❌ ID القناة غير صحيح!", flags: 64 });
            return;
        }
        if (g.panelMessageId) {
            const old = await target.messages?.fetch(g.panelMessageId).catch(() => null);
            if (old)
                await old.delete().catch(() => { });
        }
        const { embed, row } = buildPanelEmbed(g);
        const msg = await target.send({ embeds: [embed], components: [row] });
        g.applicationChannelId = id;
        g.panelMessageId = msg.id;
        saveGuild(guildId, g);
        await interaction.reply({ content: `✅ تم نشر لوحة التقديم في <#${id}>`, flags: 64 });
        return;
    }
    if (customId === "modal_add_q") {
        const text = interaction.fields.getTextInputValue("q_text");
        g.questions.push(text);
        saveGuild(guildId, g);
        await interaction.reply({ content: `✅ تمت إضافة السؤال: **${text}**`, flags: 64 });
        return;
    }
    if (customId.startsWith("modal_edit_q_")) {
        const i = parseInt(customId.replace("modal_edit_q_", ""));
        const text = interaction.fields.getTextInputValue("q_text");
        g.questions[i] = text;
        saveGuild(guildId, g);
        await interaction.reply({ content: `✅ تم تعديل السؤال ${i + 1}: **${text}**`, flags: 64 });
        return;
    }
    if (customId.startsWith("modal_reject_")) {
        const appId = customId.replace("modal_reject_", "");
        const app = g.applications[appId];
        if (!app) {
            await interaction.reply({ content: "❌ الطلب غير موجود!", flags: 64 });
            return;
        }
        const reason = interaction.fields.getTextInputValue("reason");
        app.status = "rejected";
        app.reviewedBy = interaction.user.id;
        app.reason = reason;
        delete g.pendingApplications[app.userId];
        g.cooldowns[app.userId] = Date.now() + g.cooldownHours * 3600000;
        g.applications[appId] = app;
        saveGuild(guildId, g);
        await updateLogMessage(app, "❌ مرفوض", 0xed4245);
        try {
            const reviewer = await interaction.guild.members.fetch(interaction.user.id);
            const applicant = await client.users.fetch(app.userId);
            await applicant.send({
                embeds: [new EmbedBuilder().setColor(0xed4245)
                        .setTitle(`${emojiText(e.reject)} تم رفض طلبك`)
                        .setDescription(cfg.text.rejectMsg)
                        .addFields({ name: "السبب", value: reason }, { name: "راجعه", value: `<@${reviewer.id}>`, inline: true })
                        .setTimestamp()],
            });
        }
        catch { }
        await interaction.reply({ content: "❌ تم رفض الطلب وإخطار المتقدم.", flags: 64 });
    }
}
// ─── EMBED BUILDERS ───────────────────────────────────────────────────────────
function buildPanelEmbed(g) {
    const pt = g ? getPanelText(g) : {
        title: cfg.text.panelTitle,
        description: cfg.text.panelDescription,
        footer: cfg.text.panelFooter,
        buttonLabel: "تقديم الآن",
    };
    const embed = new EmbedBuilder()
        .setTitle(`${emojiText(e.apply)} ${pt.title}`)
        .setDescription(pt.description)
        .setColor(0x5865f2)
        .setFooter({ text: pt.footer })
        .setTimestamp();
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("apply_start")
        .setLabel(pt.buttonLabel)
        .setEmoji(resolveEmoji(e.apply))
        .setStyle(ButtonStyle.Primary));
    return { embed, row };
}
function buildApplicationEmbed(app, num) {
    const embed = new EmbedBuilder()
        .setTitle(`${emojiText(e.new)} طلب تقديم جديد — #${num}`)
        .setColor(0xffa500)
        .setThumbnail(app.userAvatar)
        .addFields({ name: "👤 المتقدم", value: `<@${app.userId}> (${app.username})`, inline: true }, { name: "🆔 ID", value: app.userId, inline: true }, { name: "📅 إنشاء الحساب", value: app.accountCreated, inline: true }, { name: "📆 الانضمام", value: app.joinedServer, inline: true }, { name: "⏰ وقت التقديم", value: `<t:${Math.floor(new Date(app.appliedAt).getTime() / 1000)}:F>`, inline: true }, { name: "\u200b", value: "\u200b" })
        .setTimestamp();
    app.questions.forEach((q, i) => embed.addFields({ name: `❓ س${i + 1}: ${q}`, value: app.answers[i] || "_—_" }));
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`app_accept_${app.id}`).setLabel("قبول").setEmoji(resolveEmoji(e.accept)).setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`app_reject_${app.id}`).setLabel("رفض").setEmoji(resolveEmoji(e.reject)).setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`app_info_${app.id}`).setLabel("معلومات").setEmoji(resolveEmoji(e.info)).setStyle(ButtonStyle.Secondary));
    return { embed, row };
}
function buildQuestionsStatusEmbed(g) {
    return new EmbedBuilder()
        .setTitle("❓ إدارة الأسئلة")
        .setColor(0x5865f2)
        .addFields({
        name: `الأسئلة الحالية (${g.questions.length}/${cfg.maxQuestions})`,
        value: g.questions.length > 0
            ? g.questions.map((q, i) => `**${i + 1}.** ${q}`).join("\n")
            : "_لا توجد أسئلة بعد_",
    })
        .setTimestamp();
}
function buildQuestionsRow(questions) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("q_add").setLabel("➕ إضافة").setStyle(ButtonStyle.Success).setDisabled(questions.length >= cfg.maxQuestions), new ButtonBuilder().setCustomId("q_edit").setLabel("✏️ تعديل").setStyle(ButtonStyle.Primary).setDisabled(questions.length === 0), new ButtonBuilder().setCustomId("q_remove").setLabel("🗑️ حذف").setStyle(ButtonStyle.Danger).setDisabled(questions.length === 0), new ButtonBuilder().setCustomId("q_clear").setLabel("🧹 حذف الكل").setStyle(ButtonStyle.Danger).setDisabled(questions.length === 0));
}
async function checkReviewer(interaction, g) {
    if (!g.reviewRoleId)
        return true;
    try {
        const m = await interaction.guild.members.fetch(interaction.user.id);
        if (!m.roles.cache.has(g.reviewRoleId) && !m.permissions.has("Administrator")) {
            await interaction.reply({ content: "❌ ليس لديك صلاحية مراجعة الطلبات!", flags: 64 });
            return false;
        }
    }
    catch {
        return false;
    }
    return true;
}
async function updateLogMessage(app, label, color) {
    if (!app.logMessageId || !app.logChannelId)
        return;
    const ch = await client.channels.fetch(app.logChannelId).catch(() => null);
    if (!ch?.isTextBased())
        return;
    const msg = await ch.messages.fetch(app.logMessageId).catch(() => null);
    if (!msg)
        return;
    const updated = EmbedBuilder.from(msg.embeds[0]).setColor(color).setTitle(`${msg.embeds[0].title} — ${label}`);
    await msg.edit({ embeds: [updated], components: [] });
}
// ─── START ───────────────────────────────────────────────────────────────────
client.login(token);
