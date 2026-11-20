const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const pino  = require('pino');
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
require('dotenv').config();

// yt-search optional - graceful fallback
let yts = null;
try { yts = require('yt-search'); } catch(e) { console.log('yt-search nahi mila - npm install karo'); }

// ytdl-core for direct YouTube download (no API needed)
let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); } catch(e) { console.log('ytdl-core nahi mila'); }

// play-dl as fallback for direct download
let playdl = null;
try { playdl = require('play-dl'); } catch(e) { console.log('play-dl nahi mila'); }

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const YT_LINK  = 'https://youtube.com/@blazexty?si=ow_uzTqxRkPfOS3x';

if (!TG_TOKEN) {
    console.log('❌ .env mein TELEGRAM_BOT_TOKEN daalo!');
    process.exit(1);
}

// ── Config (bot image + settings) ──────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function getBotImg() {
    const cfg = loadConfig();
    return cfg.BOT_IMG || '';
}
function getMenuSong() {
    const cfg = loadConfig();
    const p = path.join(__dirname, cfg.MENU_SONG || 'assets/menu_song.mp3');
    return fs.existsSync(p) ? p : null;
}

const tgBot   = new TelegramBot(TG_TOKEN, { polling: true });
const sessions = {};
const warns    = {};

// Temp + assets folders
['tmp','temp','assets'].forEach(d => fs.mkdirSync(path.join(__dirname, d), { recursive: true }));

// ── Gali list ──────────────────────────────────────
const GALI = [
    'madarchod','maderchod','bhenchod','bsdk','chutiya','chutiye',
    'randi','harami','kamina','gandu','gaandu','bhosdike','bhosdi',
    'lauda','lund','fuck','fucker','fucking','bitch','bastard',
    'asshole','motherfucker','bc','mc','lode','maa ki','baap ki',
    'sala','saala','haramzada','kutte','kamine','ullu','gadha'
];

function hasGali(t) {
    if (!t) return false;
    const l = t.toLowerCase().replace(/[^a-z\u0900-\u097f ]/g, ' ');
    return GALI.some(w => l.includes(w));
}

function isEmojiOnly(t) {
    if (!t?.trim()) return false;
    const clean = t.replace(
        /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{1F300}-\u{1F9FF}]|[\u00a9\u00ae\u2122\u2139\u203c\u2049\u20e3\u2194-\u2199\u21a9\u21aa\u231a\u231b\u23e9-\u23f3\u24c2\u25aa\u25ab\u25b6\u25c0\u25fb-\u25fe\u2600-\u2604\u260e\u2611\u2614\u2615\u2638-\u263a\u2648-\u2653\u267f\u2702\u2705\u2708-\u270d\u2712\u2714\u2716\u2728\u2733\u2734\u2744\u2747\u274c\u274e\u2753-\u2757\u2763\u2764\u2795-\u2797\u27a1\u27b0\u27bf\u2934\u2935\u2b05-\u2b07\u2b1b\u2b1c\u2b50\u2b55\u3030\u303d\u3297\u3299]/gu,
        ''
    ).replace(/\s/g, '').trim();
    return clean.length === 0;
}

// ── Axios helper ───────────────────────────────────
const AX = {
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*' }
};

// ── Converter (ffmpeg) ─────────────────────────────
const { toAudio } = require('./lib/converter');

// ── Detect audio format from buffer ───────────────
function detectAudioFormat(buf) {
    if (!buf || buf.length < 12) return 'mp3';
    const hex = buf.slice(0, 4).toString('hex');
    const ftyp = buf.slice(4, 8).toString('ascii');
    if (ftyp === 'ftyp') return 'm4a';
    if (buf.slice(0, 4).toString('ascii') === 'OggS') return 'ogg';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'wav';
    if (hex === '1a45dfa3') return 'webm';
    if (hex.startsWith('fff') || hex.startsWith('494433')) return 'mp3';
    return 'mp3';
}

// ── YOUTUBE (engine: lib/youtube.js) ───────────────
//  .play / .song  <naam>   -> naam se audio
//  .video / .ytv  <naam>   -> naam se video
//  .ytmp3 <link>           -> link se audio
//  .ytmp4 <link>           -> link se video
const yt = require('./lib/youtube');
const YT_MAX_ACTIVE = 3;       // ek saath max itne downloads
let ytActive = 0;

const YT_USAGE = {
    'audio:name': '❌ Song ka *naam* likho!\n*Example:* .play Tum Hi Ho',
    'video:name': '❌ Video ka *naam* likho!\n*Example:* .video Alan Walker Faded',
    'audio:link': '❌ YouTube *link* do!\n*Example:* .ytmp3 https://youtu.be/xxxxxxxxxxx',
    'video:link': '❌ YouTube *link* do!\n*Example:* .ytmp4 https://youtu.be/xxxxxxxxxxx'
};
const YT_BAD_LINK = '❌ Ye sahi YouTube link nahi hai!\n*Example:* https://youtu.be/xxxxxxxxxxx';
const safeFileName = (t, fb) => (String(t || '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 60)) || fb;

// query -> { url, title, thumb, duration, seconds }  (galti par user ko message bhej ke null deta hai)
async function ytResolve(sock, from, msg, query, mode, kind) {
    const q = (query || '').trim();
    const reply = text => sock.sendMessage(from, { text: text + '\n\n⚡ SAEID MD BOT' }, { quoted: msg });

    if (!q) { await reply(YT_USAGE[`${kind}:${mode}`]); return null; }

    const direct = yt.normalizeUrl(q);
    if (direct) {
        const id = yt.extractVideoId(direct);
        return { url: direct, title: '', thumb: yt.thumbnailFor(id), duration: '', seconds: 0 };
    }
    if (mode === 'link') { await reply(YT_BAD_LINK); return null; }

    const found = await yt.search(q);
    if (!found) {
        await reply(`❌ ${kind === 'audio' ? 'Song' : 'Video'} nahi mila! Doosra naam try karo.`);
        return null;
    }
    return { url: found.url, title: found.title, thumb: found.thumbnail, duration: found.duration, seconds: found.seconds };
}

async function ytWithSlot(sock, from, msg, fn) {
    if (ytActive >= YT_MAX_ACTIVE) {
        await sock.sendMessage(from, { text: '⏳ Bot abhi busy hai, thodi der baad try karo.\n\n⚡ SAEID MD BOT' }, { quoted: msg });
        return;
    }
    ytActive++;
    try { await fn(); } finally { ytActive--; }
}

const YT_FAIL_TIPS = '\n\n💡 *Try karo:*\n• 1-2 minute baad dobara try karo\n• Doosra naam / link try karo\n• Video private ya age-restricted na ho';

// ── SONG / MP3 ─────────────────────────────────────
async function songDownload(sock, from, msg, query, mode = 'name') {
    if (!(query || '').trim()) { await ytResolve(sock, from, msg, '', mode, 'audio'); return; }

    await ytWithSlot(sock, from, msg, async () => {
        try { await sock.sendMessage(from, { react: { text: '🎵', key: msg.key } }); } catch {}

        const t = await ytResolve(sock, from, msg, query, mode, 'audio');
        if (!t) return;

        if (t.seconds && t.seconds > yt.LIMITS.maxAudioSeconds) {
            await sock.sendMessage(from, { text: '❌ Ye audio bahut lamba hai (1 ghante se zyada).\n\n⚡ SAEID MD BOT' }, { quoted: msg });
            return;
        }

        const caption = `🎵 *Song mila!*\n📌 ${t.title || 'YouTube audio'}${t.duration ? `\n⏱ ${t.duration}` : ''}\n\n⏳ Download ho raha hai... wait karo\n\n⚡ SAEID MD BOT`;
        try {
            await sock.sendMessage(from, {
                image: { url: t.thumb || getBotImg() || 'https://i.imgur.com/6lMRPqo.png' }, caption
            }, { quoted: msg });
        } catch {
            await sock.sendMessage(from, { text: caption }, { quoted: msg });
        }

        const res = await yt.download('audio', t.url, m => console.log('[YT-AUDIO]', m));
        if (!res.ok) {
            console.log('[YT-AUDIO] sab methods fail:', res.errors.join(' | '));
            await sock.sendMessage(from, { text: '❌ *Song download nahi hua!*' + YT_FAIL_TIPS + '\n\n⚡ SAEID MD BOT' }, { quoted: msg });
            return;
        }

        let audioBuf = res.buffer;
        const finalTitle = res.title || t.title || 'YouTube audio';

        // Sahi MP3 me convert (ffmpeg) agar zarurat ho
        const ext = detectAudioFormat(audioBuf);
        if (ext !== 'mp3') {
            try { audioBuf = await toAudio(audioBuf, ext); }
            catch (e) { console.log('Conversion error:', e.message); }
        }

        await sock.sendMessage(from, {
            audio: audioBuf, mimetype: 'audio/mpeg',
            fileName: `${safeFileName(finalTitle, 'song')}.mp3`, ptt: false
        }, { quoted: msg });

        await sock.sendMessage(from, { text: `✅ *${finalTitle}*\n\n👑 —͟͞͞SꫝEɪD\n⚡ SAEID MD BOT` });
    });
}

// ── YOUTUBE VIDEO / MP4 ────────────────────────────
async function ytVideoDownload(sock, from, msg, query, mode = 'name') {
    if (!(query || '').trim()) { await ytResolve(sock, from, msg, '', mode, 'video'); return; }

    await ytWithSlot(sock, from, msg, async () => {
        try { await sock.sendMessage(from, { react: { text: '🎬', key: msg.key } }); } catch {}

        const t = await ytResolve(sock, from, msg, query, mode, 'video');
        if (!t) return;

        if (t.seconds && t.seconds > yt.LIMITS.maxVideoSeconds) {
            await sock.sendMessage(from, { text: '❌ Ye video bahut lamba hai (30 minute se zyada).\n\n⚡ SAEID MD BOT' }, { quoted: msg });
            return;
        }

        const caption = `🎬 *Video mila!*\n📌 ${t.title || 'YouTube video'}${t.duration ? `\n⏱ ${t.duration}` : ''}\n\n⏳ Download ho raha hai... wait karo\n\n⚡ SAEID MD BOT`;
        try {
            await sock.sendMessage(from, {
                image: { url: t.thumb || getBotImg() || 'https://i.imgur.com/6lMRPqo.png' }, caption
            }, { quoted: msg });
        } catch {
            await sock.sendMessage(from, { text: caption }, { quoted: msg });
        }

        const res = await yt.download('video', t.url, m => console.log('[YT-VIDEO]', m));
        if (!res.ok) {
            console.log('[YT-VIDEO] sab methods fail:', res.errors.join(' | '));
            await sock.sendMessage(from, { text: '❌ *Video download nahi hua!*' + YT_FAIL_TIPS + '\n\n⚡ SAEID MD BOT' }, { quoted: msg });
            return;
        }

        const finalTitle = res.title || t.title || 'YouTube video';
        const cap = `✅ *${finalTitle}*\n\n👑 —͟͞͞SꫝEɪD\n⚡ SAEID MD BOT`;

        if (res.buffer.length > yt.LIMITS.videoInlineMaxBytes) {
            // badi file: document ki tarah bhejte hain taaki WhatsApp reject na kare
            await sock.sendMessage(from, {
                document: res.buffer, mimetype: 'video/mp4',
                fileName: `${safeFileName(finalTitle, 'video')}.mp4`, caption: cap
            }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { video: res.buffer, mimetype: 'video/mp4', caption: cap }, { quoted: msg });
        }
    });
}

// ── INSTAGRAM DOWNLOAD ─────────────────────────────
async function instaDownload(sock, from, msg, url) {
    if (!url || !url.includes('instagram.com')) {
        await sock.sendMessage(from, { text: '❌ Instagram link daalo!\n*Example:* .insta https://instagram.com/reel/xxx' }, { quoted: msg });
        return;
    }

    for (const e of ['📥','⏳','📸']) {
        try { await sock.sendMessage(from, { react: { text: e, key: msg.key } }); } catch {}
    }

    await sock.sendMessage(from, { text: '📥 Instagram se download ho raha hai...\n⏳ Wait karo...' }, { quoted: msg });

    const instaApis = [
        async () => {
            const r = await axios.get(`https://api.vreden.my.id/api/igdownload?url=${encodeURIComponent(url)}`, AX);
            if (r?.data?.status && r?.data?.result?.length) return r.data.result;
            throw new Error('fail');
        },
        async () => {
            const r = await axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/instagram?url=${encodeURIComponent(url)}`, AX);
            if (r?.data?.result?.length) return r.data.result;
            throw new Error('fail');
        },
        async () => {
            const r = await axios.get(`https://api.yupra.my.id/api/downloader/ig?url=${encodeURIComponent(url)}`, AX);
            if (r?.data?.data?.length) return r.data.data;
            throw new Error('fail');
        }
    ];

    let mediaList = null;
    for (const api of instaApis) {
        try { mediaList = await api(); if (mediaList?.length) break; } catch {}
    }

    if (!mediaList?.length) {
        await sock.sendMessage(from, { text: '❌ Download fail!\nPublic post ka link daalo, private nahi chalega.' }, { quoted: msg });
        return;
    }

    for (const item of mediaList.slice(0, 5)) {
        const mUrl = item.url || item.download_url || item.src;
        const isVid = item.type === 'video' || /\.(mp4|mov)/i.test(mUrl);
        try {
            await sock.sendMessage(from, isVid
                ? { video: { url: mUrl }, caption: '✅ Instagram Video\n\n👑 —͟͞͞SꫝEɪD\n⚡ SAEID MD BOT' }
                : { image: { url: mUrl }, caption: '✅ Instagram Image\n\n👑 —͟͞͞SꫝEɪD\n⚡ SAEID MD BOT' }
            , { quoted: msg });
        } catch {}
    }
}

// ── Bot Messages ───────────────────────────────────
function welcomeMsg(name, group) {
    return `╔══════════════════════════════════╗
║    ⚡  SAEID MD BOT  ⚡    ║
║   👑  Developed by —͟͞͞SꫝEɪD  ║
╚══════════════════════════════════╝

🎉 *Welcome to ${group}!*
👋 Aayo *${name}* bhai!

📌 *Rules:*
✅ Sabka izzat karo
🚫 Gali = Instant KICK
🚫 Sirf Emoji = Instant KICK
🚫 Spam/Link = Instant KICK

📋 Commands: *.menu*

👑 *—͟͞͞SꫝEɪD*
🔗 ${YT_LINK}
⚡ *SAEID MD BOT*`;
}

const RULES_MSG = `╔══════════════════════════════════╗
║    ⚡  SAEID MD BOT  ⚡    ║
║        📋  GROUP RULES           ║
╚══════════════════════════════════╝

1️⃣ Sabka izzat karo
2️⃣ Gali = KICK
3️⃣ Sirf Emoji = KICK
4️⃣ Spam/Link = KICK
5️⃣ Kisi ko bully mat karo
6️⃣ Fake news mat failao
7️⃣ Topic pe raho

⚠️ *3 Warnings = Auto KICK!*

👑 *—͟͞͞SꫝEɪD*
🔗 ${YT_LINK}
⚡ *SAEID MD BOT*`;

const MENU_MSG = `
╔━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╗
┃  🖤⚡  *SAEID MD BOT*  ⚡🖤   ┃
╚━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╝
▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
         👑 *Dev: —͟͞͞SꫝEɪD* 👑
▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰

🎵 *━━━[ MUSIC & VIDEO ]━━━*
╔════════════════════════════╗
║ 🎵 \`.play <song naam>\` (ya .song)
║      ➤ Naam se song download
║ 🎬 \`.video <naam>\` (ya .ytv)
║      ➤ Naam se YouTube video
║ 🎧 \`.ytmp3 <link>\`
║      ➤ Link se MP3 download
║ 📹 \`.ytmp4 <link>\`
║      ➤ Link se MP4 download
║ 📸 \`.insta <link>\`
║      ➤ Instagram download
╚════════════════════════════╝

😂 *━━━[ FUN & INFO ]━━━*
╔════════════════════════════╗
║ 😂 \`.joke\`   ➤ Random joke
║ 💡 \`.quote\`  ➤ Motivation
║ 🕐 \`.time\`   ➤ Current time
║ ℹ️  \`.info\`   ➤ Bot/Group info
║ 📋 \`.about\`  ➤ Bot ke baare mein
╚════════════════════════════╝

👥 *━━━[ GROUP ONLY ]━━━*
╔════════════════════════════╗
║ 📢 \`.tagall\`      ➤ Sabko tag
║ 📏 \`.rules\`       ➤ Group rules
║ 👢 \`.kick @user\`  ➤ Kick (Admin)
║ ⚠️  \`.warn @user\`  ➤ Warn (Admin)
╚════════════════════════════╝

🛡️ *━━━[ AUTO SAFETY ]━━━*
╔════════════════════════════╗
║ 🚫 Anti-Gali  ➤ Auto Kick
║ 🚫 Anti-Link  ➤ Auto Kick
║ 🔞 Anti-Emoji ➤ Auto Kick
╚════════════════════════════╝

⚙️ *━━━[ BOT SETTINGS ]━━━*
╔════════════════════════════╗
║ 🖼️ \`.setbanner <url>\`
║      ➤ Bot banner change karo
╚════════════════════════════╝

▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
🔗 *YT:* ${YT_LINK}
🖤 *Powered by SAEID MD BOT* 🖤
▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰`;

const JOKES = [
    "Teacher: Future use karo sentence mein!\nStudent: Main future mein school nahi aaunga! 😂",
    "Doctor: Kya problem hai?\nAadmi: Main invisible hun!\nDoctor: Next patient! 😂",
    "Wife: Prove karo pyaar karte ho!\nHusband: Maine remote uthaya! 😂",
    "Beta: Papa first aaya main!\nPapa: Class mein?\nBeta: Ghar mein! 😂"
];
const QUOTES = [
    "⚡ *Sapne wo nahi jo sote waqt aate hain, sapne wo hain jo sone nahi dete!*\n— A.P.J Abdul Kalam",
    "⚡ *Haar tabhi hoti hai jab tum khud haar maan lo!*",
    "⚡ *Jo girne ke baad uthna jaanta hai wahi aage jaata hai!*",
    "⚡ *Mushkilein manzil tak pahuncha deti hain!*"
];

// ══════════════════════════════════════════════════
class Session {
    constructor(chatId) {
        this.chatId   = chatId;
        this.authPath = path.join(__dirname, 'sessions', chatId);
        this.sock     = null;
        fs.mkdirSync(this.authPath, { recursive: true });
    }

    async start(phone) {
        const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
        const { version } = await fetchLatestBaileysVersion();
        this.sock = makeWASocket({
            version, auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            // Speed + stability settings
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
        });
        this.sock.ev.on('creds.update', saveCreds);

        // ── Connection handler (auto-reconnect) ──────
        this.sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (connection === 'open') {
                this._reconnectCount = 0;
                // Clear keepalive timer if any
                if (this._keepAlive) clearInterval(this._keepAlive);
                // Keepalive ping every 4 min to stay connected
                this._keepAlive = setInterval(async () => {
                    try { await this.sock.sendPresenceUpdate('available'); } catch {}
                }, 4 * 60 * 1000);

                await tgBot.sendMessage(this.chatId,
                    `✅ *SAEID MD BOT CONNECTED!*\n\n⚡ Bot ready! Commands use karo!\n👑 Developer: —͟͞͞SꫝEɪD`,
                    { parse_mode: 'Markdown' });
            }
            if (connection === 'close') {
                if (this._keepAlive) clearInterval(this._keepAlive);
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const logout = statusCode === DisconnectReason.loggedOut;

                if (logout) {
                    await tgBot.sendMessage(this.chatId, '❌ *Logout ho gaya!*\nDobara /pair karo.', { parse_mode: 'Markdown' });
                    fs.rmSync(this.authPath, { recursive: true, force: true });
                    delete sessions[this.chatId];
                } else {
                    // Smart reconnect with backoff
                    this._reconnectCount = (this._reconnectCount || 0) + 1;
                    const delay = Math.min(3000 * this._reconnectCount, 30000);
                    console.log(`Reconnect attempt ${this._reconnectCount} in ${delay}ms...`);
                    setTimeout(() => this.start(null), delay);
                }
            }
        });

        // Pairing code
        if (phone && !this.sock.authState.creds.registered) {
            await new Promise(r => setTimeout(r, 3000));
            try {
                const code = await this.sock.requestPairingCode(phone);
                await tgBot.sendMessage(this.chatId,
                    `🔑 *PAIRING CODE:*\n\n\`${code}\`\n\n*WhatsApp mein:*\nSettings ▶ Linked Devices ▶ Link a Device ▶ *Link with phone number* ▶ Code daalo`,
                    { parse_mode: 'Markdown' });
            } catch(e) {
                await tgBot.sendMessage(this.chatId, `❌ Error: ${e.message}`);
            }
        }

        // Messages
        this.sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                try {
                    if (!msg.message) continue;
                    const from    = msg.key.remoteJid;
                    if (!from) continue;

                    const isGroup  = from.endsWith('@g.us');
                    const isFromMe = msg.key.fromMe;
                    const sender   = msg.key.participant || from;
                    const senderN  = sender.split('@')[0];
                    const text     = msg.message?.conversation ||
                                     msg.message?.extendedTextMessage?.text || '';
                    const cmd  = text.trim();
                    const cmdL = cmd.toLowerCase();
                    const S    = this.sock;

                    // Group metadata sirf group mein
                    let meta = null, admins = [], botAdmin = false, isAdmin = false, allJids = [];
                    if (isGroup) {
                        try {
                            meta     = await S.groupMetadata(from);
                            admins   = meta.participants.filter(p => p.admin);
                            const botJid = jidNormalizedUser(S.user.id);
                            botAdmin = admins.some(a => jidNormalizedUser(a.id) === botJid);
                            isAdmin  = isFromMe || admins.some(a => jidNormalizedUser(a.id) === jidNormalizedUser(sender));
                            allJids  = meta.participants.map(p => p.id);
                        } catch(e) {}
                    }

                    // ── GENERAL COMMANDS (Private + Group dono) ──────────
                    if (cmdL === '.menu' || cmdL === '.help') {
                        const botImg = getBotImg();
                        // Banner image (agar set hai)
                        if (botImg) {
                            await S.sendMessage(from, { image: { url: botImg }, caption: MENU_MSG });
                        } else {
                            await S.sendMessage(from, { text: MENU_MSG });
                        }
                        // Menu song bhejna (sirf .menu ke saath)
                        const songPath = getMenuSong();
                        if (songPath) {
                            try {
                                const songBuf = fs.readFileSync(songPath);
                                await S.sendMessage(from, {
                                    audio: songBuf,
                                    mimetype: 'audio/mpeg',
                                    fileName: 'genius_md_bot.mp3',
                                    ptt: false
                                });
                            } catch(e) { console.log('Menu song error:', e.message); }
                        }
                        continue;
                    }
                    // .setbanner - banner image change karo (group admin ya private)
                    if (cmdL.startsWith('.setbanner')) {
                        const url = cmd.slice(10).trim();
                        if (!url) {
                            await S.sendMessage(from, { text: '❌ URL daalo!\n*Example:* .setbanner https://...' }, { quoted: msg });
                        } else {
                            const cfg = loadConfig(); cfg.BOT_IMG = url; saveConfig(cfg);
                            await S.sendMessage(from, { image: { url }, caption: '✅ *Banner set ho gaya!*\n.menu karo check karne ke liye 🎨\n\n⚡ SAEID MD BOT' }, { quoted: msg });
                        }
                        continue;
                    }
                    // .setimage - same as setbanner
                    if (cmdL.startsWith('.setimage')) {
                        const url = cmd.slice(9).trim();
                        if (!url) {
                            await S.sendMessage(from, { text: '❌ URL daalo!\n*Example:* .setimage https://...' }, { quoted: msg });
                        } else {
                            const cfg = loadConfig(); cfg.BOT_IMG = url; saveConfig(cfg);
                            await S.sendMessage(from, { image: { url }, caption: '✅ *Bot image set ho gaya!*\n.menu karo check karne ke liye 🖼️\n\n⚡ SAEID MD BOT' }, { quoted: msg });
                        }
                        continue;
                    }
                    if (cmdL === '.rules') {
                        await S.sendMessage(from, { text: RULES_MSG });
                        continue;
                    }
                    if (cmdL === '.info') {
                        if (isGroup && meta) {
                            await S.sendMessage(from, { text: `╔══════════════════╗\n║  📊 GROUP INFO   ║\n╚══════════════════╝\n\n📌 *Naam:* ${meta.subject}\n👥 *Members:* ${meta.participants.length}\n📝 *Desc:* ${meta.desc||'N/A'}\n\n⚡ SAEID MD BOT` });
                        } else {
                            await S.sendMessage(from, { text: `╔══════════════════╗\n║   ℹ️  BOT INFO   ║\n╚══════════════════╝\n\n🤖 *Naam:* SAEID MD BOT\n👑 *Dev:* —͟͞͞SꫝEɪD\n🔗 ${YT_LINK}\n\n⚡ SAEID MD BOT` });
                        }
                        continue;
                    }
                    if (cmdL === '.joke') {
                        await S.sendMessage(from, { text: `😂 *JOKE!*\n\n${JOKES[Math.floor(Math.random()*JOKES.length)]}\n\n⚡ SAEID MD BOT` });
                        continue;
                    }
                    if (cmdL === '.quote') {
                        await S.sendMessage(from, { text: `💡 *QUOTE*\n\n${QUOTES[Math.floor(Math.random()*QUOTES.length)]}\n\n⚡ SAEID MD BOT` });
                        continue;
                    }
                    if (cmdL === '.time') {
                        await S.sendMessage(from, { text: `🕐 *TIME (IST)*\n📅 ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}\n\n⚡ SAEID MD BOT` });
                        continue;
                    }
                    if (cmdL === '.about') {
                        const aboutImg = getBotImg();
                        const aboutMsgOpts = aboutImg
                            ? { image: { url: aboutImg }, caption: `╔══════════════════════════════════╗\n║  ⚡  SAEID MD BOT  ⚡  ║\n╚══════════════════════════════════╝\n\n👑 *Dev:* —͟͞͞SꫝEɪD\n🔗 ${YT_LINK}\n\n✅ Auto Welcome\n🚫 Anti-Gali/Emoji/Link\n⚠️ Warning System\n🎵 Song | 🎬 YouTube | 📸 Instagram\n\n⚡ SAEID MD BOT` }
                            : { text: `╔══════════════════════════════════╗\n║  ⚡  SAEID MD BOT  ⚡  ║\n╚══════════════════════════════════╝\n\n👑 *Dev:* —͟͞͞SꫝEɪD\n🔗 ${YT_LINK}\n\n✅ Auto Welcome\n🚫 Anti-Gali/Emoji/Link\n⚠️ Warning System\n🎵 Song | 🎬 YouTube | 📸 Instagram\n\n⚡ SAEID MD BOT` };
                        await S.sendMessage(from, aboutMsgOpts);
                        continue;
                    }

                    // ── YOUTUBE: naam se (.play/.song/.video/.ytv) ya link se (.ytmp3/.ytmp4) ──
                    {
                        const ym = cmd.match(/^\.(play|song|ytmp3|video|ytv|ytmp4)(?:\s+([\s\S]*))?$/i);
                        if (ym) {
                            const name = ym[1].toLowerCase();
                            const q = (ym[2] || '').trim();
                            const isAudio = ['play', 'song', 'ytmp3'].includes(name);
                            const mode = (name === 'ytmp3' || name === 'ytmp4') ? 'link' : 'name';
                            try {
                                if (isAudio) await songDownload(S, from, msg, q, mode);
                                else await ytVideoDownload(S, from, msg, q, mode);
                            } catch (e) {
                                console.log('[YT] error:', e);
                                await S.sendMessage(from, { text: `❌ YouTube Error: ${e.message}` }, { quoted: msg });
                            }
                            continue;
                        }
                    }

                    // ── INSTAGRAM ─────────────────
                    if (cmdL.startsWith('.insta') || cmdL.startsWith('.ig ')) {
                        const q = cmd.replace(/^\.(insta|ig)\s*/i, '').trim();
                        try { await instaDownload(S, from, msg, q); }
                        catch(e) { await S.sendMessage(from, { text: `❌ Insta Error: ${e.message}` }, { quoted: msg }); }
                        continue;
                    }

                    // ── GROUP-ONLY ADMIN COMMANDS ────────────
                    if (isGroup && isAdmin) {
                        if (cmdL === '.tagall') {
                            let t = `📢 *ATTENTION!*\n\n`;
                            allJids.forEach(j => { t += `@${j.split('@')[0]} `; });
                            await S.sendMessage(from, { text: t + '\n\n⚡ SAEID MD BOT', mentions: allJids });
                            continue;
                        }
                        if (cmdL.startsWith('.kick')) {
                            const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                            if (target) {
                                await S.sendMessage(from, { text: `🚫 @${target.split('@')[0]} KICK!\n⚡ SAEID MD BOT`, mentions: [target] });
                                await S.groupParticipantsUpdate(from, [target], 'remove');
                            }
                            continue;
                        }
                        if (cmdL.startsWith('.warn')) {
                            const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                            if (target) {
                                const key = `${target}:${from}`;
                                warns[key] = (warns[key] || 0) + 1;
                                if (warns[key] >= 3) {
                                    await S.sendMessage(from, { text: `⚠️ @${target.split('@')[0]} 3 warnings → KICK!\n⚡ SAEID MD BOT`, mentions: [target] });
                                    await S.groupParticipantsUpdate(from, [target], 'remove');
                                    delete warns[key];
                                } else {
                                    await S.sendMessage(from, { text: `⚠️ @${target.split('@')[0]} Warning ${warns[key]}/3\n⚡ SAEID MD BOT`, mentions: [target] });
                                }
                            }
                            continue;
                        }
                    }

                    // ── AUTO SAFETY (sirf group mein) ───────────────
                    if (!isGroup || !botAdmin || isAdmin || isFromMe) continue;

                    if (hasGali(text)) {
                        await S.sendMessage(from, { text: `🚫 @${senderN} *GALI MANA HAI!*\n❌ KICK!\n👑 —͟͞͞SꫝEɪD\n⚡ SAEID MD BOT`, mentions: [sender] });
                        await new Promise(r => setTimeout(r, 1000));
                        await S.groupParticipantsUpdate(from, [sender], 'remove');
                        continue;
                    }
                    if (isEmojiOnly(text)) {
                        await S.sendMessage(from, { text: `🚫 @${senderN} *Sirf emoji MANA!*\n❌ KICK!\n👑 —͟͞͞SꫝEɪD\n⚡ SAEID MD BOT`, mentions: [sender] });
                        await new Promise(r => setTimeout(r, 1000));
                        await S.groupParticipantsUpdate(from, [sender], 'remove');
                        continue;
                    }
                    if (/(https?:\/\/|www\.|t\.me\/|chat\.whatsapp\.com\/)/i.test(text)) {
                        await S.sendMessage(from, { text: `🚫 @${senderN} *Link MANA!*\n❌ KICK!\n👑 —͟͞͞SꫝEɪD\n⚡ SAEID MD BOT`, mentions: [sender] });
                        await new Promise(r => setTimeout(r, 1000));
                        await S.groupParticipantsUpdate(from, [sender], 'remove');
                        continue;
                    }

                } catch(e) { console.log('Msg Error:', e.message); }
            }
        });

        // Welcome on join
        this.sock.ev.on('group-participants.update', async (update) => {
            try {
                if (update.action !== 'add') return;
                const meta = await this.sock.groupMetadata(update.id);
                for (const p of update.participants) {
                    let name = p.split('@')[0];
                    try { const c = await this.sock.getContact(p); name = c?.notify || c?.name || name; } catch {}
                    const wImg = getBotImg();
                    if (wImg) {
                        await this.sock.sendMessage(update.id, { image: { url: wImg }, caption: welcomeMsg(name, meta.subject) });
                    } else {
                        await this.sock.sendMessage(update.id, { text: welcomeMsg(name, meta.subject) });
                    }
                }
            } catch {}
        });
    }
}

// ── Telegram Bot ───────────────────────────────────
tgBot.onText(/\/start/, async (msg) => {
    const id = msg.chat.id.toString();
    await tgBot.sendMessage(id,
`╔══════════════════════════════════╗
║    ⚡  SAEID MD BOT  ⚡    ║
║   👑  Developed by —͟͞͞SꫝEɪD  ║
╚══════════════════════════════════╝

🔗 ${YT_LINK}

*Connect karne ke liye number bhejo:*
Example: \`917086852797\`

*Features:*
🎉 Auto Welcome + Image
🚫 Anti-Gali/Emoji/Link → Kick
🎵 Song (.play / .song) | 🎧 MP3 link (.ytmp3)
🎬 Video (.video / .ytv) | 📹 MP4 link (.ytmp4)
📸 Instagram (.insta)
⚠️ Warning System

⚡ *SAEID MD BOT*`,
        { parse_mode: 'Markdown' });
});

// /setimage <url> - Bot image/banner Telegram se change karo
tgBot.onText(/\/setimage (.+)/, async (msg, match) => {
    const id  = msg.chat.id.toString();
    const url = match[1].trim();
    const cfg = loadConfig(); cfg.BOT_IMG = url; saveConfig(cfg);
    try {
        await tgBot.sendPhoto(id, url, { caption: `✅ *Bot image set ho gaya!*\nWhatsApp pe .menu karo check karne ke liye 🖼️`, parse_mode: 'Markdown' });
    } catch {
        await tgBot.sendMessage(id, `✅ *Bot image URL save ho gaya!*\n\`${url}\`\n\nWhatsApp pe .menu karo check karne ke liye.`, { parse_mode: 'Markdown' });
    }
});

// /setimage bina URL ke - help
tgBot.onText(/\/setimage$/, async (msg) => {
    await tgBot.sendMessage(msg.chat.id.toString(),
        `🖼️ *Bot Image Change:*\n\nFormat:\n\`/setimage <image_url>\`\n\nExample:\n\`/setimage https://i.ibb.co/example.jpg\`\n\nYe image .menu aur welcome mein use hogi.`,
        { parse_mode: 'Markdown' });
});

// /help - Telegram commands list
tgBot.onText(/\/help/, async (msg) => {
    await tgBot.sendMessage(msg.chat.id.toString(),
`⚡ *SAEID MD BOT - Help*

📱 *WhatsApp pair karne ke liye:*
Number bhejo: \`917086852797\`

⚙️ *Telegram Commands:*
/start — Bot shuru karo
/pair — WhatsApp pair guide
/unpair — Disconnect karo
/status — Connection status
/setimage <url> — Bot banner/image change karo
/help — Ye message

💡 *WhatsApp Commands:*
.menu — Full menu + song
.play / .song <naam> — Song download
.video / .ytv <naam> — YT video
.ytmp3 <link> — MP3 (link se)
.ytmp4 <link> — MP4 (link se)
.insta — Instagram
.setbanner <url> — Banner change (WA se)
.setimage <url> — Image change (WA se)

👑 Developer: —͟͞͞SꫝEɪD`,
        { parse_mode: 'Markdown' });
});

tgBot.on('message', async (msg) => {
    const id   = msg.chat.id.toString();
    const text = msg.text?.trim() || '';
    if (text.startsWith('/')) return;
    const phone = text.replace(/[^0-9]/g, '');
    if (phone.length < 10 || phone.length > 15) return;
    await tgBot.sendMessage(id,
        `⏳ *Connecting...*\nNumber: +${phone}\n\nCode 5 sec mein aayega...`,
        { parse_mode: 'Markdown' });
    if (!sessions[id]) sessions[id] = new Session(id);
    await sessions[id].start(phone);
});

console.log(`
╔══════════════════════════════════╗
║   ⚡  SAEID MD BOT  ⚡    ║
║  👑  Developed by —͟͞͞SꫝEɪD   ║
╚══════════════════════════════════╝
✅ Bot chalu hai! Telegram pe number bhejo.
`);
