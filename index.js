const {
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN        = process.env.BOT_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const GUILD_ID               = process.env.GUILD_ID;
const WITHDRAW_CHANNEL_ID    = '1490404391814168616'; // withdraw admin cards go here
const REQUEST_CHANNEL_ID     = '1490404544268603503'; // request limit admin cards go here

const XP_PER_MSG_MIN   = 1;
const XP_PER_MSG_MAX   = 2;
const DAILY_XP_CAP     = 150;
const REDEEM_COST      = 2500;
const MONTHLY_MAX      = 2;
const ADMIN_IDS        = ['1166382223923097684', '1080494184626126992']; // full admins (withdraw + request)
const REQUEST_ADMIN_IDS = ['1166382223923097684', '1080494184626126992', '1231892462000279706', '1204044462414635069']; // can only do request buttons
const REQUEST_COOLDOWN_MS   = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_WEEKLY_MAX    = 1;                   // max 1 reset request per week

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const DB_FILE = './db.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function monthKey() { return new Date().toISOString().slice(0, 7); }
function weekKey() {
  const now = new Date();
  // ISO week: year + week number
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${week}`;
}

function getUser(db, userId) {
  if (!db[userId]) {
    db[userId] = {
      totalXp: 0,
      dailyXp: 0,
      lastDailyReset: todayKey(),
      monthlyRedeems: 0,
      lastMonthReset: monthKey(),
      // reset request tracking
      lastRequestTs: 0,       // timestamp of last /requestresetlimit use
      weeklyRequests: 0,      // how many requests sent this week
      lastRequestWeek: '',    // week key when requests were last counted
    };
  }
  return db[userId];
}

function resetIfNeeded(user) {
  if (user.lastDailyReset !== todayKey()) {
    user.dailyXp = 0;
    user.lastDailyReset = todayKey();
  }
  if (user.lastMonthReset !== monthKey()) {
    user.monthlyRedeems = 0;
    user.lastMonthReset = monthKey();
  }
  if (user.lastRequestWeek !== weekKey()) {
    user.weeklyRequests = 0;
    user.lastRequestWeek = weekKey();
  }
}

// Format ms remaining into a readable string like "5h 23m"
function formatCooldown(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── XP ON CHAT ───────────────────────────────────────────────────────────────
client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  const db   = loadDB();
  const user = getUser(db, message.author.id);
  resetIfNeeded(user);
  if (user.dailyXp >= DAILY_XP_CAP) return;
  const gained     = Math.floor(Math.random() * (XP_PER_MSG_MAX - XP_PER_MSG_MIN + 1)) + XP_PER_MSG_MIN;
  const actualGain = Math.min(gained, DAILY_XP_CAP - user.dailyXp);
  user.totalXp += actualGain;
  user.dailyXp += actualGain;
  saveDB(db);
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── /chatxp ──────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'chatxp') {
    const db   = loadDB();
    const user = getUser(db, interaction.user.id);
    resetIfNeeded(user);
    saveDB(db);

    const embed = new EmbedBuilder()
      .setTitle('💬 Your Chat XP')
      .setColor(0x5865F2)
      .addFields(
        { name: '⭐ Total XP',        value: `**${user.totalXp} XP**`,                          inline: true },
        { name: '📅 Daily XP Used',   value: `**${user.dailyXp} / ${DAILY_XP_CAP} XP**`,        inline: true },
        { name: '📈 Daily XP Left',   value: `**${DAILY_XP_CAP - user.dailyXp} XP**`,            inline: true },
        { name: '🎁 Monthly Redeems', value: `**${user.monthlyRedeems} / ${MONTHLY_MAX} used**`, inline: true },
        { name: '💎 Redeem Cost',     value: `**${REDEEM_COST} XP**`,                            inline: true },
        { name: '✅ Can Redeem?',     value: user.totalXp >= REDEEM_COST && user.monthlyRedeems < MONTHLY_MAX ? '**Yes!**' : '**No**', inline: true },
      )
      .setFooter({ text: 'Daily resets at midnight • Monthly redeems reset each month' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /redeemxp ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'redeemxp') {
    const db   = loadDB();
    const user = getUser(db, interaction.user.id);
    resetIfNeeded(user);

    if (user.totalXp < REDEEM_COST) {
      return interaction.reply({ content: `❌ You need **${REDEEM_COST} XP** to redeem. You only have **${user.totalXp} XP**.`, ephemeral: true });
    }
    if (user.monthlyRedeems >= MONTHLY_MAX) {
      return interaction.reply({
        content: `❌ You've used all **${MONTHLY_MAX}** redeems this month.\n\nTip: Use **/requestresetlimit** to request a reset from admins!`,
        ephemeral: true,
      });
    }
    saveDB(db);

    const embed = new EmbedBuilder()
      .setTitle('🎁 Redeem Robux')
      .setColor(0x57F287)
      .setDescription(`You have **${user.totalXp} XP** — this costs **${REDEEM_COST} XP**.\n\nClick the button below to enter your Gamepass link and Discord username.`)
      .addFields({ name: 'Redeems left this month', value: `${MONTHLY_MAX - user.monthlyRedeems}`, inline: true });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_redeem_modal').setLabel('🎮 Enter Gamepass Details').setStyle(ButtonStyle.Success)
    );
    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // ── /requestresetlimit ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'requestresetlimit') {
    const db   = loadDB();
    const user = getUser(db, interaction.user.id);
    resetIfNeeded(user);

    const now = Date.now();

    // 6h cooldown check
    const timeSinceLast = now - (user.lastRequestTs || 0);
    if (timeSinceLast < REQUEST_COOLDOWN_MS) {
      const remaining = REQUEST_COOLDOWN_MS - timeSinceLast;
      return interaction.reply({
        content: `⏳ You're on cooldown! You can use this command again in **${formatCooldown(remaining)}**.`,
        ephemeral: true,
      });
    }

    // Weekly limit check (max 1 per week)
    if (user.weeklyRequests >= REQUEST_WEEKLY_MAX) {
      return interaction.reply({
        content: `❌ You've already used your **1 reset request** for this week. Try again next week!`,
        ephemeral: true,
      });
    }

    // Update cooldown + weekly count
    user.lastRequestTs   = now;
    user.weeklyRequests += 1;
    saveDB(db);

    // Send to webhook as "Requests" bot
    try {
      // Confirm to user
      await interaction.reply({
        content: `✅ **Reset request sent!**\nAdmins will review your request. You'll get a DM with their decision.\n\n> You can make **1 request per week** and the command has a **6h cooldown**.`,
        ephemeral: true,
      });

      // Admin card in channel with Accept / Cancel buttons
      const uid = interaction.user.id;
      const adminEmbed = new EmbedBuilder()
        .setTitle('📋 Redeem Limit Reset Request')
        .setColor(0x5865F2)
        .setDescription(`**${interaction.user.username}** is requesting a monthly redeem limit reset.`)
        .addFields(
          { name: '👤 Username',        value: interaction.user.username,  inline: true  },
          { name: '🆔 User ID',         value: uid,                        inline: true  },
          { name: '🎁 Current Redeems', value: `${user.monthlyRedeems} / ${MONTHLY_MAX}`, inline: true },
          { name: '⭐ Total XP',        value: `${user.totalXp} XP`,       inline: true  },
        )
        .setFooter({ text: 'Requests • Accept to reset their monthly redeem count' })
        .setTimestamp();

      const adminRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`accept_reset_${uid}`)
          .setLabel('✅ Accept Request')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cancel_reset_${uid}`)
          .setLabel('❌ Cancel Request')
          .setStyle(ButtonStyle.Danger),
      );

      const requestCh = await client.channels.fetch(REQUEST_CHANNEL_ID).catch(() => null);
      if (requestCh) {
        await requestCh.send({ embeds: [adminEmbed], components: [adminRow] });
      } else {
        await interaction.channel.send({ embeds: [adminEmbed], components: [adminRow] });
      }

    } catch (err) {
      console.error('Error:', err);
      // Rollback
      user.lastRequestTs  -= REQUEST_COOLDOWN_MS;
      user.weeklyRequests -= 1;
      saveDB(db);
      return interaction.reply({ content: '❌ Something went wrong sending the request. Please try again.', ephemeral: true });
    }
  }

  // ── Button: Accept reset request ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('accept_reset_')) {
    if (!REQUEST_ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: `🚫 **Access Denied.** Pls don't try again.`, ephemeral: true });
    const targetUserId = interaction.customId.replace('accept_reset_', '');
    try {
      const db   = loadDB();
      const user = getUser(db, targetUserId);
      // Reset their monthly redeem count
      user.monthlyRedeems = 0;
      saveDB(db);

      const targetUser = await client.users.fetch(targetUserId);
      await targetUser.send(
        `✅ **Your redeem limit has been reset!**\n\n` +
        `An admin has approved your request — your monthly withdrawal count is now reset to **0 / ${MONTHLY_MAX}**.\n\n` +
        `You can now use **/redeemxp** again! 🎉`
      );

      const doneRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('req_done1').setLabel('✅ Accepted — Limit Reset').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('req_done2').setLabel('❌ Cancel Request').setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      await interaction.update({ components: [doneRow] });

    } catch (err) {
      console.error('Error:', err);
      await interaction.reply({ content: `❌ Couldn't DM the user (DMs may be off). User ID: \`${targetUserId}\``, ephemeral: true });
    }
  }

  // ── Button: Cancel reset request ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('cancel_reset_')) {
    if (!REQUEST_ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: `🚫 **Access Denied.** Pls don't try again.`, ephemeral: true });
    const targetUserId = interaction.customId.replace('cancel_reset_', '');
    try {
      const targetUser = await client.users.fetch(targetUserId);
      await targetUser.send(
        `❌ **Your redeem limit reset request was denied.**\n\n` +
        `An admin has reviewed and declined your request.\n` +
        `If you think this is a mistake, please contact an admin directly.`
      );

      const doneRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('req_done1').setLabel('✅ Accept Request').setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId('req_done2').setLabel('❌ Cancelled — DM Sent').setStyle(ButtonStyle.Secondary).setDisabled(true),
      );
      await interaction.update({ components: [doneRow] });

    } catch (err) {
      console.error('Error:', err);
      await interaction.reply({ content: `❌ Couldn't DM the user (DMs may be off). User ID: \`${targetUserId}\``, ephemeral: true });
    }
  }

  // ── Button: open redeem modal ─────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'open_redeem_modal') {
    const modal = new ModalBuilder().setCustomId('redeem_modal').setTitle('💰 Robux Withdrawal Request');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('gamepass_link')
          .setLabel('Gamepass Link')
          .setPlaceholder('https://www.roblox.com/game-pass/...')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('discord_user')
          .setLabel('Your Discord Username')
          .setPlaceholder('e.g. username or username#0000')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
    );
    return interaction.showModal(modal);
  }

  // ── Modal submit: withdrawal form ─────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'redeem_modal') {
    const gamepassLink = interaction.fields.getTextInputValue('gamepass_link');
    const discordUser  = interaction.fields.getTextInputValue('discord_user');

    const db   = loadDB();
    const user = getUser(db, interaction.user.id);
    resetIfNeeded(user);

    if (user.totalXp < REDEEM_COST) return interaction.reply({ content: '❌ Not enough XP!', ephemeral: true });
    if (user.monthlyRedeems >= MONTHLY_MAX) return interaction.reply({ content: '❌ Monthly limit reached! Use **/requestresetlimit** to ask for a reset.', ephemeral: true });

    user.totalXp       -= REDEEM_COST;
    user.monthlyRedeems += 1;
    saveDB(db);

    try {
      await interaction.reply({
        content: `✅ **Withdrawal submitted!**\n**${REDEEM_COST} XP** deducted. You now have **${user.totalXp} XP**.\n\nYou'll get a DM once your Robux has been delivered! 🎉`,
        ephemeral: true,
      });

      const uid = interaction.user.id;
      const adminEmbed = new EmbedBuilder()
        .setTitle('💰 Pending Withdrawal')
        .setColor(0xFFA500)
        .setDescription(`**${interaction.user.username}** has requested a Robux withdrawal.`)
        .addFields(
          { name: '👤 Discord User (form)', value: discordUser,          inline: true  },
          { name: '🆔 Discord ID',          value: uid,                  inline: true  },
          { name: '🎮 Gamepass Link',       value: gamepassLink,         inline: false },
          { name: '⭐ XP Spent',            value: `${REDEEM_COST} XP`,  inline: true  },
          { name: '📊 Their Remaining XP', value: `${user.totalXp} XP`,  inline: true  },
        )
        .setFooter({ text: 'PotatoPoorWithdraw' })
        .setTimestamp();

      const adminRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sended_${uid}`).setLabel('✅ Sended').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`onhold_${uid}`).setLabel('⏳ On Hold').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cancel_${uid}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
      );

      const withdrawCh = await client.channels.fetch(WITHDRAW_CHANNEL_ID).catch(() => null);
      if (withdrawCh) {
        await withdrawCh.send({ embeds: [adminEmbed], components: [adminRow] });
      } else {
        await interaction.channel.send({ embeds: [adminEmbed], components: [adminRow] });
      }

    } catch (err) {
      console.error('Error:', err);
      user.totalXp       += REDEEM_COST;
      user.monthlyRedeems -= 1;
      saveDB(db);
      return interaction.reply({ content: '❌ Something went wrong. Your XP has been refunded. Please try again.', ephemeral: true });
    }
  }

  // ── Button: Sended ────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sended_')) {
    if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: `🚫 **Access Denied.** Pls don't try again.`, ephemeral: true });
    const targetUserId = interaction.customId.replace('sended_', '');
    try {
      const targetUser = await client.users.fetch(targetUserId);
      await targetUser.send(
        `✅ **Withdraw Success!**\n\n` +
        `Check Transaction — Robux Delivered! 🎉\n\n` +
        `Thank you hello nihaho potato fans Enjoy your robux!`
      );
      const doneRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('d1').setLabel('✅ Sended — DM Delivered').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('d2').setLabel('⏳ On Hold').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('d3').setLabel('❌ Cancel').setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      await interaction.update({ components: [doneRow] });
    } catch (err) {
      console.error('DM error:', err);
      await interaction.reply({ content: `❌ Couldn't DM the user (DMs may be off). User ID: \`${targetUserId}\``, ephemeral: true });
    }
  }

  // ── Button: On Hold ───────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('onhold_')) {
    if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: `🚫 **Access Denied.** Pls don't try again.`, ephemeral: true });
    const targetUserId = interaction.customId.replace('onhold_', '');
    try {
      const targetUser = await client.users.fetch(targetUserId);
      await targetUser.send(
        `⏳ **Your Robux is on its way!**\n\n` +
        `Your Robux will be delivered soon — please wait for us, it can take some days.\n\n` +
        `We appreciate your patience! 🙏`
      );
      const holdRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sended_${targetUserId}`).setLabel('✅ Sended').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`onhold_${targetUserId}`).setLabel('⏳ On Hold — DM Sent').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`cancel_${targetUserId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
      );
      await interaction.update({ components: [holdRow] });
    } catch (err) {
      console.error('DM error:', err);
      await interaction.reply({ content: `❌ Couldn't DM the user (DMs may be off). User ID: \`${targetUserId}\``, ephemeral: true });
    }
  }

  // ── Button: Cancel withdrawal → reason modal ──────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('cancel_') && !interaction.customId.startsWith('cancel_reset_')) {
    if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: `🚫 **Access Denied.** Pls don't try again.`, ephemeral: true });
    const targetUserId = interaction.customId.replace('cancel_', '');
    const modal = new ModalBuilder()
      .setCustomId(`cancel_reason_${targetUserId}`)
      .setTitle('❌ Cancel Withdrawal');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('cancel_reason')
          .setLabel('Reason for cancellation')
          .setPlaceholder('e.g. Invalid gamepass link, duplicate request...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }

  // ── Modal: cancel reason → DM user ───────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('cancel_reason_')) {
    const targetUserId = interaction.customId.replace('cancel_reason_', '');
    const reason       = interaction.fields.getTextInputValue('cancel_reason');
    try {
      const targetUser = await client.users.fetch(targetUserId);
      await targetUser.send(
        `❌ **Your Robux withdrawal has been cancelled.**\n\n` +
        `**Reason:** ${reason}\n\n` +
        `If you think this is a mistake, please contact an admin.`
      );
      const cancelledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('d1').setLabel('✅ Sended').setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId('d2').setLabel('⏳ On Hold').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('d3').setLabel('❌ Cancelled — DM Sent').setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      await interaction.update({ components: [cancelledRow] });
    } catch (err) {
      console.error('DM error:', err);
      await interaction.reply({ content: `❌ Couldn't DM the user (DMs may be off). User ID: \`${targetUserId}\`\n**Reason:** ${reason}`, ephemeral: true });
    }
  }

  // ── /adminabuse ───────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'adminabuse') {
    if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: `🚫 **Access Denied.** Pls don't try again.`, ephemeral: true });

    const mode       = interaction.options.getString('mode');   // 'add' or 'set'
    const targetUser = interaction.options.getUser('user');
    const xpAmount   = interaction.options.getInteger('xp');

    const db   = loadDB();
    const user = getUser(db, targetUser.id);
    resetIfNeeded(user);

    const oldXp = user.totalXp;

    if (mode === 'add') {
      user.totalXp += xpAmount;
    } else if (mode === 'remove') {
      user.totalXp = Math.max(0, user.totalXp - xpAmount);
    } else {
      // set — replace their XP entirely
      user.totalXp = xpAmount;
    }
    saveDB(db);

    const modeLabel = mode === 'add' ? '➕ XP Added' : mode === 'remove' ? '➖ XP Removed' : '📝 XP Set To';
    const modeValue = mode === 'add' ? `**+${xpAmount} XP**` : mode === 'remove' ? `**-${xpAmount} XP**` : `**${xpAmount} XP**`;

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Admin XP Grant')
      .setColor(0xFF6B00)
      .addFields(
        { name: '👤 User',        value: `${targetUser.username} (${targetUser.id})`, inline: false },
        { name: '🔧 Mode',        value: mode === 'add' ? '**Add XP**' : mode === 'remove' ? '**Remove XP**' : '**Set XP**', inline: true },
        { name: modeLabel,        value: modeValue,                                    inline: true },
        { name: '📊 XP Before',  value: `${oldXp} XP`,                                inline: true },
        { name: '⭐ XP After',   value: `**${user.totalXp} XP**`,                     inline: true },
      )
      .setFooter({ text: `Done by ${interaction.user.username}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }


  // ── /adminabuselimits ─────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'adminabuselimits') {
    if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: `🚫 **Access Denied.** Pls don't try again.`, ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const db   = loadDB();
    const user = getUser(db, targetUser.id);
    resetIfNeeded(user);

    const oldRedeems = user.monthlyRedeems;
    user.monthlyRedeems = 0;
    saveDB(db);

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Admin — Withdraw Limit Reset')
      .setColor(0xFF6B00)
      .addFields(
        { name: '👤 User',              value: `${targetUser.username} (${targetUser.id})`, inline: false },
        { name: '🎁 Redeems Before',    value: `**${oldRedeems} / ${MONTHLY_MAX}**`,        inline: true  },
        { name: '✅ Redeems Now',       value: `**0 / ${MONTHLY_MAX}**`,                    inline: true  },
      )
      .setFooter({ text: `Reset by ${interaction.user.username}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

});

// ─── REGISTER COMMANDS ────────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('chatxp')
      .setDescription('Check your total and daily Chat XP'),
    new SlashCommandBuilder()
      .setName('redeemxp')
      .setDescription('Redeem your XP for Robux (costs 2500 XP, max 2x per month)'),
    new SlashCommandBuilder()
      .setName('requestresetlimit')
      .setDescription('Request admins to reset your monthly redeem limit (1x per week, 6h cooldown)'),
    new SlashCommandBuilder()
      .setName('adminabuse')
      .setDescription('(Admin only) Add or set XP for any user')
      .addStringOption(opt =>
        opt.setName('mode')
          .setDescription('Add XP on top, or set their total XP')
          .setRequired(true)
          .addChoices(
            { name: 'Add XP',    value: 'add'    },
            { name: 'Set XP',    value: 'set'    },
            { name: 'Remove XP', value: 'remove' },
          )
      )
      .addUserOption(opt => opt.setName('user').setDescription('The user').setRequired(true))
      .addIntegerOption(opt => opt.setName('xp').setDescription('XP amount').setRequired(true).setMinValue(0)),
    new SlashCommandBuilder()
      .setName('adminabuselimits')
      .setDescription('(Admin only) Remove a user\'s withdraw limit')
      .addUserOption(opt => opt.setName('user').setDescription('The user to reset').setRequired(true)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    // If GUILD_ID is set, wipe any old guild commands for that server first
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
      console.log('✅ Old guild commands cleared');
    }
    // Always register globally so the bot works in every server
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Global commands registered — will appear in all servers within ~1hr on first install, instantly on restart');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  registerCommands();
});

client.login(TOKEN);