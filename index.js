cat > /home/claude/borderland-final/index.js << 'ENDOFFILE'
const {
  Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
  REST, Routes, StringSelectMenuBuilder,
} = require('discord.js');
const fs = require('fs');
const http = require('http');

// ─── Base de données locale ───────────────────────────────────────────────────
const DB_FILE = './data/cards.json';

function loadDB() {
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ players: {}, games: [] }));
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── Constantes ───────────────────────────────────────────────────────────────
const SUITS = {
  '♠': { name: 'Pique',    color: 0x2C2C2A, emoji: '♠️', type: 'Force' },
  '♥': { name: 'Cœur',    color: 0xD4537E, emoji: '♥️', type: 'Psychologie' },
  '♦': { name: 'Carreau',  color: 0xE85D24, emoji: '♦️', type: 'Intelligence' },
  '♣': { name: 'Trèfle',  color: 0x1D9E75, emoji: '♣️', type: 'Endurance' },
};

const JOKERS = {
  JR: { name: 'Joker Rouge', color: 0xE83333 },
  JN: { name: 'Joker Noir',  color: 0x1A1A1A },
};

const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const TICKET_CATEGORIES = {
  'ticket_jeu':    { label: '🎮 Jeu',    color: 0x3B8BD4 },
  'ticket_report': { label: '⚠️ Report', color: 0xE85D24 },
  'ticket_cartes': { label: '🃏 Cartes', color: 0xC8A84A },
  'ticket_autre':  { label: '❓ Autre',  color: 0x888780 },
};

function buildFullDeck() {
  const deck = [];
  for (const suit of Object.keys(SUITS))
    for (const v of VALUES) deck.push({ suit, value: v });
  deck.push({ suit: 'JR', value: 'JOKER' });
  deck.push({ suit: 'JN', value: 'JOKER' });
  return deck;
}
const FULL_DECK = buildFullDeck();

// ─── État en mémoire ──────────────────────────────────────────────────────────
const pendingResets    = new Map();
const pendingGifts     = new Map();
const pendingExchanges = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shortId() { return Math.random().toString(36).slice(2, 8); }

function cardValue(value) {
  if (value === 'JOKER') return 14;
  return VALUES.indexOf(value);
}

function cardKey(suit, value) { return `${suit}|${value}`; }

function parseCardKey(key) {
  const idx = key.indexOf('|');
  return { suit: key.slice(0, idx), value: key.slice(idx + 1) };
}

function formatCard(suit, value) {
  if (suit === 'JR') return '🃏 **Joker Rouge**';
  if (suit === 'JN') return '🃏 **Joker Noir**';
  return `${SUITS[suit].emoji} **${value}${suit}**`;
}

function formatCardShort(suit, value) {
  if (suit === 'JR') return 'Joker Rouge';
  if (suit === 'JN') return 'Joker Noir';
  return `${value}${suit}`;
}

function getPlayerData(db, userId) {
  if (!db.players[userId])
    db.players[userId] = { cards: [], wins: 0, losses: 0, gamesPlayed: 0 };
  return db.players[userId];
}

function removeOneCard(playerCards, suit, value) {
  const idx = playerCards.findIndex(c => c.suit === suit && c.value === value);
  if (idx !== -1) playerCards.splice(idx, 1);
  return idx !== -1;
}

function isStaff(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.roles.cache.some(r =>
      ['Chapelier', 'administrateurs', 'activiste', 'Maître du Jeu', 'Garde de la Plage'].some(n =>
        r.name.toLowerCase().includes(n.toLowerCase())
      )
    );
}

function isChapelier(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.roles.cache.some(r => r.name.toLowerCase().includes('chapelier'));
}

async function logMod(guild, embed) {
  const ch = guild.channels.cache.find(c =>
    ['logs-modération', 'logs-moderation', 'mod-logs', 'logs-mod'].includes(c.name)
  );
  if (ch) { try { await ch.send({ embeds: [embed] }); } catch {} }
}

function buildDeckEmbed(user, playerData) {
  const bySuit = { '♠': [], '♥': [], '♦': [], '♣': [], jokers: [] };
  for (const c of playerData.cards) {
    if (c.suit === 'JR' || c.suit === 'JN') bySuit.jokers.push(c);
    else bySuit[c.suit].push(c.value);
  }
  for (const s of Object.keys(SUITS)) bySuit[s].sort((a, b) => cardValue(b) - cardValue(a));

  const totalCards = playerData.cards.length;
  const best = playerData.cards.reduce((b, c) => (!b || cardValue(c.value) > cardValue(b.value) ? c : b), null);
  const bestColor = best ? (SUITS[best.suit]?.color ?? JOKERS[best.suit]?.color ?? 0x888780) : 0x888780;
  const jokerLine = bySuit.jokers.length
    ? bySuit.jokers.map(c => `\`${JOKERS[c.suit].name}\``).join(' ')
    : '*Aucun*';

  return new EmbedBuilder()
    .setTitle(`🃏 Deck de ${user.displayName || user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(bestColor)
    .addFields(
      { name: '♠️ Pique — Force',          value: bySuit['♠'].length ? bySuit['♠'].map(v => `\`${v}♠\``).join(' ') : '*Aucune*', inline: true },
      { name: '♥️ Cœur — Psychologie',     value: bySuit['♥'].length ? bySuit['♥'].map(v => `\`${v}♥\``).join(' ') : '*Aucune*', inline: true },
      { name: '♦️ Carreau — Intelligence', value: bySuit['♦'].length ? bySuit['♦'].map(v => `\`${v}♦\``).join(' ') : '*Aucune*', inline: true },
      { name: '♣️ Trèfle — Endurance',     value: bySuit['♣'].length ? bySuit['♣'].map(v => `\`${v}♣\``).join(' ') : '*Aucune*', inline: true },
      { name: '🃏 Jokers',                 value: jokerLine, inline: true },
      {
        name: '📊 Statistiques',
        value: [
          `🃏 Total : **${totalCards}**`,
          `🏆 Victoires : **${playerData.wins}**`,
          `💀 Défaites : **${playerData.losses}**`,
          `🎮 Parties : **${playerData.gamesPlayed}**`,
          best ? `⭐ Meilleure : \`${formatCardShort(best.suit, best.value)}\`` : '',
        ].filter(Boolean).join('\n'),
        inline: false,
      }
    )
    .setFooter({ text: 'Alice in Borderland — La Plage des Jeux' })
    .setTimestamp();
}

function buildCardSelectOptions(playerData) {
  const seen = new Set();
  return playerData.cards
    .filter(c => { const k = cardKey(c.suit, c.value); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 25)
    .map(c => ({
      label: c.suit === 'JR' ? '🃏 Joker Rouge' : c.suit === 'JN' ? '🃏 Joker Noir' : `${c.value}${c.suit}`,
      value: cardKey(c.suit, c.value),
      description: c.suit === 'JR' || c.suit === 'JN' ? JOKERS[c.suit].name : `${SUITS[c.suit].name} — valeur ${c.value}`,
    }));
}

function buildExchangeEmbed(ex, phase) {
  const aOffer = ex.aCards.map(c => formatCardShort(c.suit, c.value)).join(', ') || '*(rien sélectionné)*';
  const bOffer = ex.bCards.map(c => formatCardShort(c.suit, c.value)).join(', ') || '*(rien sélectionné)*';
  const embed = new EmbedBuilder()
    .setTitle('🔄 Échange de cartes')
    .setColor(0x7F77DD)
    .addFields(
      { name: `Offre de <@${ex.aId}>`, value: aOffer, inline: true },
      { name: `Offre de <@${ex.bId}>`, value: bOffer, inline: true },
    )
    .setFooter({ text: 'Expire dans 2 minutes' })
    .setTimestamp();
  if (phase === 'confirming') {
    embed.addFields({
      name: 'Confirmations',
      value: [`<@${ex.aId}> : ${ex.aConfirmed ? '✅' : '⏳'}`, `<@${ex.bId}> : ${ex.bConfirmed ? '✅' : '⏳'}`].join('\n'),
    });
  }
  return embed;
}

function cancelExchange(exchId) {
  const ex = pendingExchanges.get(exchId);
  if (!ex) return;
  clearTimeout(ex.timeoutHandle);
  pendingExchanges.delete(exchId);
  return ex;
}

// ─── Commandes Slash ──────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('lancerjeu')
    .setDescription('[STAFF] Lance un jeu')
    .addStringOption(o => o.setName('type').setDescription('Type de jeu').setRequired(true)
      .addChoices(
        { name: '♠️ Pique — Force', value: '♠' },
        { name: '♥️ Cœur — Psychologie', value: '♥' },
        { name: '♦️ Carreau — Intelligence', value: '♦' },
        { name: '♣️ Trèfle — Endurance', value: '♣' },
      ))
    .addStringOption(o => o.setName('nom').setDescription('Nom du jeu').setRequired(true))
    .addIntegerOption(o => o.setName('valeur').setDescription('Valeur (2–10=chiffre, 11=J, 12=Q, 13=K, 14=A)').setRequired(true).setMinValue(2).setMaxValue(14)),

  new SlashCommandBuilder()
    .setName('donnercartes')
    .setDescription('[STAFF] Donne une carte à un joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Le joueur').setRequired(true))
    .addStringOption(o => o.setName('enseigne').setDescription('Enseigne').setRequired(true)
      .addChoices(
        { name: '♠️ Pique', value: '♠' },
        { name: '♥️ Cœur', value: '♥' },
        { name: '♦️ Carreau', value: '♦' },
        { name: '♣️ Trèfle', value: '♣' },
        { name: '🃏 Joker Rouge', value: 'JR' },
        { name: '🃏 Joker Noir', value: 'JN' },
      ))
    .addStringOption(o => o.setName('valeur').setDescription('Valeur (2-10, J, Q, K, A, JOKER)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('retirercartes')
    .setDescription('[STAFF] Retire une carte d\'un joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Le joueur').setRequired(true))
    .addStringOption(o => o.setName('enseigne').setDescription('Enseigne').setRequired(true)
      .addChoices(
        { name: '♠️ Pique', value: '♠' },
        { name: '♥️ Cœur', value: '♥' },
        { name: '♦️ Carreau', value: '♦' },
        { name: '♣️ Trèfle', value: '♣' },
        { name: '🃏 Joker Rouge', value: 'JR' },
        { name: '🃏 Joker Noir', value: 'JN' },
      ))
    .addStringOption(o => o.setName('valeur').setDescription('Valeur (2-10, J, Q, K, A, JOKER)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('resetjoueur')
    .setDescription('[CHAPELIER] Retire toutes les cartes d\'un joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Le joueur').setRequired(true)),

  new SlashCommandBuilder()
    .setName('mesdeck')
    .setDescription('Affiche toutes tes cartes et ton profil'),

  new SlashCommandBuilder()
    .setName('voirdeck')
    .setDescription('Voir le deck d\'un joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Le joueur').setRequired(true)),

  new SlashCommandBuilder()
    .setName('classement')
    .setDescription('Classement des joueurs par nombre de cartes'),

  new SlashCommandBuilder()
    .setName('historique')
    .setDescription('Derniers jeux organisés'),

  new SlashCommandBuilder()
    .setName('cartesrestantes')
    .setDescription('Affiche les 54 cartes : disponibles vs récoltées'),

  new SlashCommandBuilder()
    .setName('donner')
    .setDescription('Donne une de tes cartes à un autre joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Le destinataire').setRequired(true))
    .addStringOption(o => o.setName('enseigne').setDescription('Enseigne').setRequired(true)
      .addChoices(
        { name: '♠️ Pique', value: '♠' },
        { name: '♥️ Cœur', value: '♥' },
        { name: '♦️ Carreau', value: '♦' },
        { name: '♣️ Trèfle', value: '♣' },
        { name: '🃏 Joker Rouge', value: 'JR' },
        { name: '🃏 Joker Noir', value: 'JN' },
      ))
    .addStringOption(o => o.setName('valeur').setDescription('Valeur (2-10, J, Q, K, A, JOKER)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('echanger')
    .setDescription('Propose un échange de cartes avec un autre joueur')
    .addUserOption(o => o.setName('joueur').setDescription('Le joueur avec qui échanger').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setuptickets')
    .setDescription('[STAFF] Envoie le panneau de tickets dans ce salon'),
];

// ─── Déploiement des commandes ────────────────────────────────────────────────
async function deployCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Déploiement des commandes slash...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('✅ Commandes déployées !');
  } catch (err) {
    console.error('Erreur déploiement:', err);
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── Commandes slash ──────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const db = loadDB();
  const { commandName, options, member, guild, user } = interaction;

  // ── /lancerjeu ──────────────────────────────────────────────────────────────
  if (commandName === 'lancerjeu') {
    if (!isStaff(member)) return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });
    const suit     = options.getString('type');
    const gameName = options.getString('nom');
    const raw      = options.getInteger('valeur');
    const cardVal  = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[raw] || String(raw);
    const suitData = SUITS[suit];
    const gameId   = `game_${Date.now()}`;

    db.games.unshift({ id: gameId, suit, cardValue: cardVal, name: gameName, launchedBy: member.id, launchedAt: new Date().toISOString(), winners: [], losers: [], status: 'open' });
    saveDB(db);

    const embed = new EmbedBuilder()
      .setTitle(`${suitData.emoji} Jeu lancé : ${gameName}`)
      .setColor(suitData.color)
      .setDescription([`**Type :** ${suitData.name} (${suitData.type})`, `**Récompense :** Carte \`${cardVal}${suit}\` pour les gagnants`, `**ID :** \`${gameId}\``].join('\n'))
      .setFooter({ text: `Lancé par ${member.displayName}` })
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`close_game_${gameId}`).setLabel('🏁 Terminer le jeu').setStyle(ButtonStyle.Danger)
      )],
    });
  }

  // ── /donnercartes ────────────────────────────────────────────────────────────
  else if (commandName === 'donnercartes') {
    if (!isStaff(member)) return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });
    const target = options.getUser('joueur');
    const suit   = options.getString('enseigne');
    const value  = options.getString('valeur').toUpperCase();

    if ((suit === 'JR' || suit === 'JN') && !isChapelier(member))
      return interaction.reply({ content: '❌ Seul le **Chapelier** peut attribuer des Jokers.', ephemeral: true });
    if ((suit === 'JR' || suit === 'JN') && value !== 'JOKER')
      return interaction.reply({ content: '❌ Pour un Joker, la valeur doit être `JOKER`.', ephemeral: true });
    if (suit !== 'JR' && suit !== 'JN' && !VALUES.includes(value))
      return interaction.reply({ content: `❌ Valeur invalide. Utilise : ${VALUES.join(', ')}`, ephemeral: true });

    const player = getPlayerData(db, target.id);
    player.cards.push({ suit, value, obtainedAt: new Date().toISOString() });
    saveDB(db);

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('🃏 Carte attribuée !').setColor(SUITS[suit]?.color ?? JOKERS[suit]?.color)
        .setDescription(`${formatCard(suit, value)} ajoutée au deck de <@${target.id}>`)
        .addFields({ name: 'Total cartes', value: String(player.cards.length), inline: true }).setTimestamp()],
    });
  }

  // ── /retirercartes ───────────────────────────────────────────────────────────
  else if (commandName === 'retirercartes') {
    if (!isStaff(member)) return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });
    const target = options.getUser('joueur');
    const suit   = options.getString('enseigne');
    const value  = options.getString('valeur').toUpperCase();
    const player = getPlayerData(db, target.id);

    if (!removeOneCard(player.cards, suit, value))
      return interaction.reply({ content: `❌ <@${target.id}> ne possède pas \`${formatCardShort(suit, value)}\`.`, ephemeral: true });
    saveDB(db);

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('🗑️ Carte retirée').setColor(0xE24B4A)
        .setDescription(`${formatCard(suit, value)} retirée du deck de <@${target.id}>`).setTimestamp()],
    });
  }

  // ── /resetjoueur ─────────────────────────────────────────────────────────────
  else if (commandName === 'resetjoueur') {
    if (!isChapelier(member)) return interaction.reply({ content: '❌ Réservé au **Chapelier**.', ephemeral: true });
    const target  = options.getUser('joueur');
    const player  = getPlayerData(db, target.id);
    const count   = player.cards.length;
    const resetId = shortId();

    pendingResets.set(resetId, { targetId: target.id, targetTag: target.username, staffId: member.id, cardCount: count, guildId: guild.id });
    setTimeout(() => pendingResets.delete(resetId), 30_000);

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('⚠️ Confirmation requise').setColor(0xE24B4A)
        .setDescription(`Tu vas retirer **toutes les cartes** (${count}) de <@${target.id}>.\n\nCette action est **irréversible**.`).setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`reset_confirm_${resetId}`).setLabel('✅ Confirmer').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`reset_cancel_${resetId}`).setLabel('✗ Annuler').setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
  }

  // ── /mesdeck ──────────────────────────────────────────────────────────────────
  else if (commandName === 'mesdeck') {
    const player = getPlayerData(db, user.id);
    saveDB(db);
    await interaction.reply({ embeds: [buildDeckEmbed(user, player)], ephemeral: true });
  }

  // ── /voirdeck ─────────────────────────────────────────────────────────────────
  else if (commandName === 'voirdeck') {
    const target = options.getUser('joueur');
    const player = getPlayerData(db, target.id);
    saveDB(db);
    await interaction.reply({ embeds: [buildDeckEmbed(target, player)] });
  }

  // ── /classement ───────────────────────────────────────────────────────────────
  else if (commandName === 'classement') {
    const sorted = Object.entries(db.players)
      .map(([id, d]) => ({ id, cards: d.cards.length, wins: d.wins }))
      .sort((a, b) => b.cards - a.cards || b.wins - a.wins).slice(0, 10);

    if (!sorted.length) return interaction.reply({ content: 'Aucun joueur n\'a encore de carte.', ephemeral: true });

    const medals = ['🥇', '🥈', '🥉'];
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('🏆 Classement — La Plage des Jeux').setColor(0xF2D53C)
        .setDescription(sorted.map((p, i) => `${medals[i] || `**${i + 1}.**`} <@${p.id}> — \`${p.cards}\` cartes · \`${p.wins}\` victoires`).join('\n'))
        .setFooter({ text: 'Alice in Borderland' }).setTimestamp()],
    });
  }

  // ── /historique ───────────────────────────────────────────────────────────────
  else if (commandName === 'historique') {
    const recent = db.games.slice(0, 8);
    if (!recent.length) return interaction.reply({ content: 'Aucun jeu enregistré.', ephemeral: true });

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('📜 Historique des jeux').setColor(0x7F77DD)
        .setDescription(recent.map(g => {
          const date = new Date(g.launchedAt).toLocaleDateString('fr-FR');
          return `${SUITS[g.suit].emoji} **${g.name}** — \`${g.cardValue}${g.suit}\` — ${g.status === 'closed' ? '✅' : '🟡'} — *${date}*`;
        }).join('\n'))
        .setFooter({ text: 'Alice in Borderland' }).setTimestamp()],
    });
  }

  // ── /cartesrestantes ──────────────────────────────────────────────────────────
  else if (commandName === 'cartesrestantes') {
    const taken = new Map();
    for (const player of Object.values(db.players))
      for (const c of player.cards) { const k = cardKey(c.suit, c.value); taken.set(k, (taken.get(k) || 0) + 1); }

    let totalTaken = 0, totalFree = 0;
    function suitField(suit) {
      return VALUES.map(v => {
        const k = cardKey(suit, v);
        if (taken.has(k)) { totalTaken++; return `~~${v}${suit}~~`; }
        totalFree++; return `\`${v}${suit}\``;
      }).join(' ');
    }

    const jrTaken = taken.has(cardKey('JR', 'JOKER')); if (jrTaken) totalTaken++; else totalFree++;
    const jnTaken = taken.has(cardKey('JN', 'JOKER')); if (jnTaken) totalTaken++; else totalFree++;

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('🃏 Cartes du jeu (54 cartes)').setColor(0x7F77DD)
        .setDescription(`~~carte~~ = récoltée · \`carte\` = disponible\n\n**${totalFree}** disponibles · **${totalTaken}** récoltées`)
        .addFields(
          { name: '♠️ Pique', value: suitField('♠'), inline: false },
          { name: '♥️ Cœur', value: suitField('♥'), inline: false },
          { name: '♦️ Carreau', value: suitField('♦'), inline: false },
          { name: '♣️ Trèfle', value: suitField('♣'), inline: false },
          { name: '🃏 Jokers', value: [jrTaken ? '~~Joker Rouge~~' : '`Joker Rouge`', jnTaken ? '~~Joker Noir~~' : '`Joker Noir`'].join(' · '), inline: false },
        )
        .setFooter({ text: 'Alice in Borderland — La Plage des Jeux' }).setTimestamp()],
    });
  }

  // ── /donner ───────────────────────────────────────────────────────────────────
  else if (commandName === 'donner') {
    const target = options.getUser('joueur');
    const suit   = options.getString('enseigne');
    let value    = options.getString('valeur').toUpperCase();

    if (target.id === user.id) return interaction.reply({ content: '❌ Tu ne peux pas te donner une carte à toi-même.', ephemeral: true });
    if (target.bot) return interaction.reply({ content: '❌ Tu ne peux pas donner une carte à un bot.', ephemeral: true });
    if (suit === 'JR' || suit === 'JN') value = 'JOKER';
    else if (!VALUES.includes(value)) return interaction.reply({ content: `❌ Valeur invalide. Utilise : ${VALUES.join(', ')}`, ephemeral: true });

    const senderData = getPlayerData(db, user.id);
    if (!senderData.cards.some(c => c.suit === suit && c.value === value))
      return interaction.reply({ content: `❌ Tu ne possèdes pas \`${formatCardShort(suit, value)}\`.`, ephemeral: true });

    const giftId = shortId();
    const timeoutHandle = setTimeout(async () => {
      if (!pendingGifts.has(giftId)) return;
      pendingGifts.delete(giftId);
      try { await target.send({ content: `⏳ La proposition de don de **${formatCardShort(suit, value)}** de <@${user.id}> a expiré.` }); } catch {}
    }, 5 * 60_000);

    pendingGifts.set(giftId, { senderId: user.id, senderTag: user.username, recipientId: target.id, suit, value, guildId: guild.id, channelId: interaction.channelId, timeoutHandle });

    const giftEmbed = new EmbedBuilder().setTitle('🎁 Proposition de don').setColor(SUITS[suit]?.color ?? JOKERS[suit]?.color)
      .setDescription(`<@${user.id}> te propose la carte ${formatCard(suit, value)}.\n\nAcceptes-tu ?`)
      .setFooter({ text: 'Expire dans 5 minutes' }).setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gift_accept_${giftId}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gift_refuse_${giftId}`).setLabel('✗ Refuser').setStyle(ButtonStyle.Danger),
    );

    let dmSent = false;
    try { await target.send({ embeds: [giftEmbed], components: [row] }); dmSent = true; } catch {}

    if (!dmSent) {
      await interaction.reply({ content: `<@${target.id}>, <@${user.id}> te propose une carte (MP désactivés) :`, embeds: [giftEmbed], components: [row] });
    } else {
      await interaction.reply({ content: `✅ Proposition envoyée à <@${target.id}> en MP.`, ephemeral: true });
    }
  }

  // ── /echanger ─────────────────────────────────────────────────────────────────
  else if (commandName === 'echanger') {
    const target = options.getUser('joueur');
    if (target.id === user.id) return interaction.reply({ content: '❌ Tu ne peux pas échanger avec toi-même.', ephemeral: true });
    if (target.bot) return interaction.reply({ content: '❌ Tu ne peux pas échanger avec un bot.', ephemeral: true });

    const aData = getPlayerData(db, user.id);
    const bData = getPlayerData(db, target.id);
    if (aData.cards.length === 0) return interaction.reply({ content: '❌ Tu n\'as aucune carte.', ephemeral: true });
    if (bData.cards.length === 0) return interaction.reply({ content: `❌ <@${target.id}> n'a aucune carte.`, ephemeral: true });

    const exchId = shortId();
    const aOptions = buildCardSelectOptions(aData);
    const timeoutHandle = setTimeout(async () => {
      const ex = pendingExchanges.get(exchId);
      if (!ex) return;
      pendingExchanges.delete(exchId);
      try {
        const ch = await client.channels.fetch(ex.channelId).catch(() => null);
        if (ch) { const msg = await ch.messages.fetch(ex.messageId).catch(() => null); if (msg) await msg.edit({ embeds: [new EmbedBuilder().setTitle('⏳ Échange expiré').setColor(0x888780).setDescription(`L'échange entre <@${ex.aId}> et <@${ex.bId}> a expiré.`)], components: [] }); }
      } catch {}
    }, 2 * 60_000);

    const initEmbed = buildExchangeEmbed({ aId: user.id, bId: target.id, aCards: [], bCards: [], aConfirmed: false, bConfirmed: false }, 'a_selecting');
    initEmbed.setDescription(`<@${user.id}>, sélectionne les cartes à proposer à <@${target.id}>.`);

    const msg = await interaction.reply({
      embeds: [initEmbed],
      components: [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`exch_sel_a_${exchId}`).setPlaceholder('Sélectionne tes cartes').setMinValues(1).setMaxValues(aOptions.length).addOptions(aOptions)),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`exch_next_${exchId}`).setLabel('Proposer ces cartes →').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`exch_cancel_${exchId}`).setLabel('✗ Annuler').setStyle(ButtonStyle.Secondary),
        ),
      ],
      fetchReply: true,
    });

    pendingExchanges.set(exchId, { aId: user.id, bId: target.id, phase: 'a_selecting', aCards: [], bCards: [], aConfirmed: false, bConfirmed: false, channelId: interaction.channelId, messageId: msg.id, guildId: guild.id, timeoutHandle });
  }

  // ── /setuptickets ─────────────────────────────────────────────────────────────
  else if (commandName === 'setuptickets') {
    if (!isStaff(member)) return interaction.reply({ content: '❌ Staff uniquement.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle('🎫 Support — La Plage des Jeux')
      .setColor(0xC8A84A)
      .setDescription(['Tu as un problème, un report ou une question ?', 'Clique sur le bouton ci-dessous pour ouvrir un ticket.', '', '🎮 **Jeu** — Problème pendant un jeu', '⚠️ **Report** — Signaler un membre', '🃏 **Cartes** — Réclamation de cartes', '❓ **Autre** — Toute autre demande'].join('\n'))
      .setFooter({ text: 'Alice in Borderland — La Plage des Jeux' });

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_ticket').setLabel('🎫 Ouvrir un ticket').setStyle(ButtonStyle.Primary)
      )],
    });
  }
});

// ─── Boutons & select menus ───────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  const { customId } = interaction;

  // ── Fermer un jeu ──────────────────────────────────────────────────────────
  if (interaction.isButton() && customId.startsWith('close_game_')) {
    if (!isStaff(interaction.member)) return interaction.reply({ content: '❌ Staff uniquement.', ephemeral: true });
    const gameId = customId.replace('close_game_', '');
    const db = loadDB();
    const game = db.games.find(g => g.id === gameId);
    if (!game) return interaction.reply({ content: '❌ Jeu introuvable.', ephemeral: true });
    if (game.status === 'closed') return interaction.reply({ content: '⚠️ Jeu déjà terminé.', ephemeral: true });
    game.status = 'closed';
    saveDB(db);
    await interaction.update({ components: [], embeds: [interaction.message.embeds[0], new EmbedBuilder().setTitle('🏁 Jeu terminé').setColor(0x1D9E75).setDescription(`Clôturé par <@${interaction.member.id}>`).setTimestamp()] });
  }

  // ── Reset joueur ───────────────────────────────────────────────────────────
  else if (interaction.isButton() && customId.startsWith('reset_confirm_')) {
    const resetId = customId.replace('reset_confirm_', '');
    const r = pendingResets.get(resetId);
    if (!r) return interaction.reply({ content: '❌ Confirmation expirée.', ephemeral: true });
    if (interaction.user.id !== r.staffId) return interaction.reply({ content: '❌ Pas ton action.', ephemeral: true });
    pendingResets.delete(resetId);
    const db = loadDB();
    getPlayerData(db, r.targetId).cards = [];
    saveDB(db);
    await interaction.update({ embeds: [new EmbedBuilder().setTitle('🗑️ Réinitialisé').setColor(0x1D9E75).setDescription(`Toutes les cartes de <@${r.targetId}> retirées (${r.cardCount}).`).setTimestamp()], components: [] });
    await logMod(interaction.guild, new EmbedBuilder().setTitle('🛡️ Reset joueur').setColor(0xE24B4A).addFields({ name: 'Joueur', value: `<@${r.targetId}>`, inline: true }, { name: 'Par', value: `<@${r.staffId}>`, inline: true }, { name: 'Cartes', value: String(r.cardCount), inline: true }).setTimestamp());
  }

  else if (interaction.isButton() && customId.startsWith('reset_cancel_')) {
    pendingResets.delete(customId.replace('reset_cancel_', ''));
    await interaction.update({ embeds: [new EmbedBuilder().setTitle('✗ Annulé').setColor(0x888780)], components: [] });
  }

  // ── Don : accepter ────────────────────────────────────────────────────────
  else if (interaction.isButton() && customId.startsWith('gift_accept_')) {
    const giftId = customId.replace('gift_accept_', '');
    const g = pendingGifts.get(giftId);
    if (!g) return interaction.reply({ content: '❌ Proposition expirée.', ephemeral: true });
    if (interaction.user.id !== g.recipientId) return interaction.reply({ content: '❌ Pas pour toi.', ephemeral: true });
    clearTimeout(g.timeoutHandle);
    pendingGifts.delete(giftId);
    const db = loadDB();
    const sender    = getPlayerData(db, g.senderId);
    const recipient = getPlayerData(db, g.recipientId);
    if (!removeOneCard(sender.cards, g.suit, g.value)) return interaction.update({ content: '❌ L\'expéditeur ne possède plus cette carte.', components: [], embeds: [] });
    recipient.cards.push({ suit: g.suit, value: g.value, obtainedAt: new Date().toISOString() });
    saveDB(db);
    const label = formatCardShort(g.suit, g.value);
    await interaction.update({ embeds: [new EmbedBuilder().setTitle('✅ Don accepté').setColor(0x1D9E75).setDescription(`Tu as reçu \`${label}\` de <@${g.senderId}>.`).setTimestamp()], components: [] });
    try { await (await client.users.fetch(g.senderId)).send(`✅ <@${g.recipientId}> a accepté ton don de \`${label}\`.`); } catch {}
    try { const guild = await client.guilds.fetch(g.guildId); await logMod(guild, new EmbedBuilder().setTitle('🎁 Don de carte').setColor(0x1D9E75).addFields({ name: 'Donneur', value: `<@${g.senderId}>`, inline: true }, { name: 'Receveur', value: `<@${g.recipientId}>`, inline: true }, { name: 'Carte', value: `\`${label}\``, inline: true }).setTimestamp()); } catch {}
  }

  // ── Don : refuser ─────────────────────────────────────────────────────────
  else if (interaction.isButton() && customId.startsWith('gift_refuse_')) {
    const giftId = customId.replace('gift_refuse_', '');
    const g = pendingGifts.get(giftId);
    if (!g) return interaction.reply({ content: '❌ Proposition expirée.', ephemeral: true });
    if (interaction.user.id !== g.recipientId) return interaction.reply({ content: '❌ Pas pour toi.', ephemeral: true });
    clearTimeout(g.timeoutHandle);
    pendingGifts.delete(giftId);
    const label = formatCardShort(g.suit, g.value);
    await interaction.update({ embeds: [new EmbedBuilder().setTitle('✗ Don refusé').setColor(0xE24B4A).setDescription(`Tu as refusé \`${label}\` de <@${g.senderId}>. La carte reste dans son deck.`).setTimestamp()], components: [] });
    try { await (await client.users.fetch(g.senderId)).send(`❌ <@${g.recipientId}> a refusé ton don de \`${label}\`.`); } catch {}
  }

  // ── Échange ───────────────────────────────────────────────────────────────
  else if (interaction.isStringSelectMenu() && customId.startsWith('exch_sel_a_')) {
    const ex = pendingExchanges.get(customId.replace('exch_sel_a_', ''));
    if (!ex || ex.phase !== 'a_selecting') return interaction.deferUpdate();
    if (interaction.user.id !== ex.aId) return interaction.reply({ content: '❌ Pas ton tour.', ephemeral: true });
    ex.aCards = interaction.values.map(parseCardKey);
    await interaction.deferUpdate();
  }

  else if (interaction.isStringSelectMenu() && customId.startsWith('exch_sel_b_')) {
    const ex = pendingExchanges.get(customId.replace('exch_sel_b_', ''));
    if (!ex || ex.phase !== 'b_selecting') return interaction.deferUpdate();
    if (interaction.user.id !== ex.bId) return interaction.reply({ content: '❌ Pas ton tour.', ephemeral: true });
    ex.bCards = interaction.values.map(parseCardKey);
    await interaction.deferUpdate();
  }

  else if (interaction.isButton() && customId.startsWith('exch_next_')) {
    const exchId = customId.replace('exch_next_', '');
    const ex = pendingExchanges.get(exchId);
    if (!ex || ex.phase !== 'a_selecting') return interaction.deferUpdate();
    if (interaction.user.id !== ex.aId) return interaction.reply({ content: '❌ Pas ton action.', ephemeral: true });
    if (ex.aCards.length === 0) return interaction.reply({ content: '❌ Sélectionne au moins une carte.', ephemeral: true });
    ex.phase = 'b_selecting';
    const db = loadDB();
    const bOptions = buildCardSelectOptions(getPlayerData(db, ex.bId));
    const embed = buildExchangeEmbed(ex, 'b_selecting');
    embed.setDescription(`<@${ex.bId}>, <@${ex.aId}> propose : **${ex.aCards.map(c => formatCardShort(c.suit, c.value)).join(', ')}**\n\nSélectionne ce que tu offres en échange.`);
    await interaction.update({
      embeds: [embed],
      components: [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`exch_sel_b_${exchId}`).setPlaceholder('Sélectionne tes cartes').setMinValues(1).setMaxValues(bOptions.length).addOptions(bOptions)),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`exch_propose_${exchId}`).setLabel('Proposer en échange →').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`exch_cancel_${exchId}`).setLabel('✗ Annuler').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  else if (interaction.isButton() && customId.startsWith('exch_propose_')) {
    const exchId = customId.replace('exch_propose_', '');
    const ex = pendingExchanges.get(exchId);
    if (!ex || ex.phase !== 'b_selecting') return interaction.deferUpdate();
    if (interaction.user.id !== ex.bId) return interaction.reply({ content: '❌ Pas ton action.', ephemeral: true });
    if (ex.bCards.length === 0) return interaction.reply({ content: '❌ Sélectionne au moins une carte.', ephemeral: true });
    ex.phase = 'confirming';
    await interaction.update({
      embeds: [buildExchangeEmbed(ex, 'confirming')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`exch_ok_a_${exchId}`).setLabel(`✅ ${interaction.guild.members.cache.get(ex.aId)?.displayName ?? 'Joueur A'} confirme`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`exch_ok_b_${exchId}`).setLabel(`✅ ${interaction.guild.members.cache.get(ex.bId)?.displayName ?? 'Joueur B'} confirme`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`exch_cancel_${exchId}`).setLabel('✗ Annuler').setStyle(ButtonStyle.Danger),
      )],
    });
  }

  else if (interaction.isButton() && (customId.startsWith('exch_ok_a_') || customId.startsWith('exch_ok_b_'))) {
    const isA    = customId.startsWith('exch_ok_a_');
    const exchId = customId.replace(isA ? 'exch_ok_a_' : 'exch_ok_b_', '');
    const ex     = pendingExchanges.get(exchId);
    if (!ex || ex.phase !== 'confirming') return interaction.deferUpdate();
    if (interaction.user.id !== (isA ? ex.aId : ex.bId)) return interaction.reply({ content: '❌ Ce bouton n\'est pas pour toi.', ephemeral: true });
    if (isA) ex.aConfirmed = true; else ex.bConfirmed = true;
    if (!ex.aConfirmed || !ex.bConfirmed) { await interaction.update({ embeds: [buildExchangeEmbed(ex, 'confirming')], components: interaction.message.components }); return; }
    cancelExchange(exchId);
    const db = loadDB();
    const aData = getPlayerData(db, ex.aId);
    const bData = getPlayerData(db, ex.bId);
    if (!ex.aCards.every(c => aData.cards.some(x => x.suit === c.suit && x.value === c.value)) || !ex.bCards.every(c => bData.cards.some(x => x.suit === c.suit && x.value === c.value))) {
      return interaction.update({ embeds: [new EmbedBuilder().setTitle('❌ Échange impossible').setColor(0xE24B4A).setDescription('Un joueur ne possède plus toutes les cartes. Échange annulé.').setTimestamp()], components: [] });
    }
    for (const c of ex.aCards) { removeOneCard(aData.cards, c.suit, c.value); bData.cards.push({ suit: c.suit, value: c.value, obtainedAt: new Date().toISOString() }); }
    for (const c of ex.bCards) { removeOneCard(bData.cards, c.suit, c.value); aData.cards.push({ suit: c.suit, value: c.value, obtainedAt: new Date().toISOString() }); }
    saveDB(db);
    const aGave = ex.aCards.map(c => formatCardShort(c.suit, c.value)).join(', ');
    const bGave = ex.bCards.map(c => formatCardShort(c.suit, c.value)).join(', ');
    await interaction.update({ embeds: [new EmbedBuilder().setTitle('✅ Échange réalisé !').setColor(0x1D9E75).addFields({ name: `<@${ex.aId}> a donné`, value: aGave, inline: true }, { name: `<@${ex.bId}> a donné`, value: bGave, inline: true }).setTimestamp()], components: [] });
    await logMod(interaction.guild, new EmbedBuilder().setTitle('🔄 Échange de cartes').setColor(0x1D9E75).addFields({ name: `<@${ex.aId}> a donné`, value: aGave, inline: true }, { name: `<@${ex.bId}> a donné`, value: bGave, inline: true }).setTimestamp());
  }

  else if (interaction.isButton() && customId.startsWith('exch_cancel_')) {
    const ex = pendingExchanges.get(customId.replace('exch_cancel_', ''));
    if (!ex) return interaction.deferUpdate();
    if (interaction.user.id !== ex.aId && interaction.user.id !== ex.bId) return interaction.reply({ content: '❌ Seuls les participants peuvent annuler.', ephemeral: true });
    cancelExchange(customId.replace('exch_cancel_', ''));
    await interaction.update({ embeds: [new EmbedBuilder().setTitle('✗ Échange annulé').setColor(0x888780).setDescription(`Annulé par <@${interaction.user.id}>.`).setTimestamp()], components: [] });
  }

  // ── Tickets ───────────────────────────────────────────────────────────────
  else if (interaction.isButton() && customId === 'open_ticket') {
    const { guild, member } = interaction;
    const existing = guild.channels.cache.find(c => c.name === `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
    if (existing) return interaction.reply({ content: `❌ Tu as déjà un ticket ouvert : <#${existing.id}>`, ephemeral: true });

    const ticketChannel = await guild.channels.create({
      name: `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      type: 0,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: ['ViewChannel'] },
        { id: member.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
        ...guild.roles.cache
          .filter(r => ['Chapelier', 'Maître du Jeu', 'Garde de la Plage'].some(n => r.name.includes(n)))
          .map(r => ({ id: r.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] })),
      ],
    });

    await ticketChannel.send({
      embeds: [new EmbedBuilder().setTitle('🎫 Ticket ouvert').setColor(0xC8A84A)
        .setDescription(`Bienvenue <@${member.id}> !\nDécris ton problème, le staff reviendra vers toi.\n\n**Choisis une catégorie :**`)
        .setFooter({ text: 'Alice in Borderland — La Plage des Jeux' }).setTimestamp()],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket_jeu').setLabel('🎮 Jeu').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('ticket_report').setLabel('⚠️ Report').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('ticket_cartes').setLabel('🃏 Cartes').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('ticket_autre').setLabel('❓ Autre').setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`close_ticket_${ticketChannel.id}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Danger)
        ),
      ],
    });

    await interaction.reply({ content: `✅ Ton ticket a été créé : <#${ticketChannel.id}>`, ephemeral: true });
  }

  else if (interaction.isButton() && Object.keys(TICKET_CATEGORIES).includes(customId)) {
    const cat = TICKET_CATEGORIES[customId];
    await interaction.update({
      embeds: [new EmbedBuilder().setTitle(`${cat.label} — Ticket ouvert`).setColor(cat.color).setDescription(`Catégorie : **${cat.label}**\nDécris ton problème, le staff arrive !`).setTimestamp()],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`close_ticket_${interaction.channel.id}`).setLabel('🔒 Fermer le ticket').setStyle(ButtonStyle.Danger))],
    });
  }

  else if (interaction.isButton() && customId.startsWith('close_ticket_')) {
    const channelId = customId.replace('close_ticket_', '');
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel) return;
    const logsChannel = interaction.guild.channels.cache.find(c => ['logs-modération', 'logs-moderation'].includes(c.name));
    if (logsChannel) {
      await logsChannel.send({ embeds: [new EmbedBuilder().setTitle('🔒 Ticket fermé').setColor(0xE24B4A).setDescription(`Ticket **${channel.name}** fermé par <@${interaction.user.id}>`).setTimestamp()] });
    }
    await interaction.reply({ content: '🔒 Ticket fermé, suppression dans 5 secondes...' });
    setTimeout(() => channel.delete().catch(() => {}), 5000);
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  client.guilds.cache.forEach(guild => deployCommands(guild.id));
  client.user.setActivity('La Plage des Jeux 🃏', { type: 3 });
});

// ─── Keep-alive HTTP ──────────────────────────────────────────────────────────
http.createServer((req, res) => { res.writeHead(200); res.end('Bot en ligne 🃏'); }).listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive actif sur le port ${process.env.PORT || 3000}`);
});

client.login(process.env.DISCORD_TOKEN);
ENDOFFILE
mkdir -p /home/claude/borderland-final
echo "done"
