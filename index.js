const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { Boom } = require("@hapi/boom");
const fs = require("fs");

// --- Configuration Setup (Owner & Admins) ---
const CONFIG_FILE = "config.json";
let config = { ownerJid: null, adminJids: [] };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const parsedConfig = JSON.parse(data);
      parsedConfig.adminJids = parsedConfig.adminJids || [];
      return parsedConfig;
    }
  } catch (err) {
    console.error("Error loading config file:", err);
  }
  return { ownerJid: null, adminJids: [] };
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log("Configuration saved successfully.");
  } catch (err) {
    console.error("Error saving config file:", err);
  }
}
// --- End Configuration ---

// --- State Management for Interactive Commands ---
let userState = {};
const PAGE_SIZE = 15; // Number of groups to display per page in the !htag menu

// --- Helper Function for !htag Pagination ---
async function displayGroupPage(sock, jid) {
  const state = userState[jid];
  if (!state || !state.data) return;

  const { data: groupList, currentPage } = state;
  const totalPages = Math.ceil(groupList.length / PAGE_SIZE);
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const endIndex = startIndex + PAGE_SIZE;
  const pageGroups = groupList.slice(startIndex, endIndex);

  let responseText = `*Hidden Mention - Page ${currentPage}/${totalPages}*\n\nSelect a group:\n\n`;
  pageGroups.forEach((group, index) => {
    responseText += `${startIndex + index + 1}. ${group.subject}\n`;
  });
  responseText +=
    "\nReply with a number to select.\nType *'n'* for next, *'p'* for previous, or *'c'* to cancel.";

  await sock.sendMessage(jid, { text: responseText });
}

async function startBot() {
  config = loadConfig();
  console.log("Bot Owner JID:", config.ownerJid || "Not set");
  console.log("Admin JIDs:", config.adminJids);

  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WhatsApp v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR code received, generating in terminal...");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error instanceof Boom &&
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      console.log(
        "Connection closed due to:",
        lastDisconnect.error,
        ", reconnecting:",
        shouldReconnect
      );
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === "open") {
      console.log("Connection opened!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || !msg.key) return;

    const senderJid = msg.key.participant || msg.key.remoteJid;
    const remoteJid = msg.key.remoteJid;
    const messageText = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""
    ).trim();

    const isOwner = senderJid === config.ownerJid;
    const isAdmin = config.adminJids.includes(senderJid);
    const isAuthorized = isOwner || isAdmin;

    // --- INTERACTIVE COMMAND HANDLER (for !htag reply) ---
    if (
      userState[senderJid] &&
      userState[senderJid].step === "awaiting_group_choice"
    ) {
      const state = userState[senderJid];
      const command = messageText.toLowerCase();

      // Navigation and Cancellation
      if (command === "n" || command === "next") {
        const totalPages = Math.ceil(state.data.length / PAGE_SIZE);
        if (state.currentPage < totalPages) {
          state.currentPage++;
          await displayGroupPage(sock, senderJid);
        } else {
          await sock.sendMessage(senderJid, {
            text: "You are already on the last page.",
          });
        }
        return;
      }
      if (command === "p" || command === "prev") {
        if (state.currentPage > 1) {
          state.currentPage--;
          await displayGroupPage(sock, senderJid);
        } else {
          await sock.sendMessage(senderJid, {
            text: "You are already on the first page.",
          });
        }
        return;
      }
      if (command === "c" || command === "cancel") {
        delete userState[senderJid];
        return await sock.sendMessage(senderJid, {
          text: "Process cancelled successfully.",
        });
      }

      // Numeric Choice
      const choice = parseInt(command);
      if (isNaN(choice) || choice < 1 || choice > state.data.length) {
        return await sock.sendMessage(senderJid, {
          text: "⚠️ Invalid selection. Please reply with a number from the list, or use 'n', 'p', 'c'.",
        });
      }

      const targetGroup = state.data[choice - 1];
      console.log(
        `[HTAG] User ${senderJid} chose group: ${targetGroup.subject}`
      );

      try {
        const groupMetadata = await sock.groupMetadata(targetGroup.id);
        const participants = groupMetadata.participants.map((p) => p.id);
        await sock.sendMessage(targetGroup.id, {
          text: "🚨",
          mentions: participants,
        });
        await sock.sendMessage(senderJid, {
          text: `✅ Hidden mention sent successfully to "${targetGroup.subject}".`,
        });
      } catch (err) {
        console.error("[X] Error sending hidden mention:", err);
        await sock.sendMessage(senderJid, {
          text: "❌ An error occurred. I might not be an admin in that group.",
        });
      } finally {
        delete userState[senderJid];
      }
      return;
    }

    // --- REGULAR COMMANDS ---
    const command = messageText.toLowerCase();

    if (command === "!setowner") {
      if (config.ownerJid)
        return await sock.sendMessage(
          remoteJid,
          { text: "An owner has already been set." },
          { quoted: msg }
        );
      config.ownerJid = senderJid;
      saveConfig();
      await sock.sendMessage(
        remoteJid,
        { text: `✅ Success! You are now the bot owner.` },
        { quoted: msg }
      );
      console.log(`[+] OWNER SET: ${senderJid}`);
    }

    if (command === "!setadmin") {
      if (!isOwner)
        return await sock.sendMessage(
          remoteJid,
          { text: "❌ Only the owner can use this command." },
          { quoted: msg }
        );
      const quotedMsg =
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quotedMsg)
        return await sock.sendMessage(
          remoteJid,
          {
            text: "ℹ️ Please reply to a user's message to make them an admin.",
          },
          { quoted: msg }
        );
      const targetJid = msg.message.extendedTextMessage.contextInfo.participant;
      if (config.adminJids.includes(targetJid))
        return await sock.sendMessage(
          remoteJid,
          { text: "⚠️ This user is already an admin." },
          { quoted: msg }
        );
      config.adminJids.push(targetJid);
      saveConfig();
      await sock.sendMessage(
        remoteJid,
        { text: `✅ User has been promoted to admin.` },
        { quoted: msg }
      );
      console.log(`[+] ADMIN ADDED: ${targetJid}`);
    }

    if (command === "!deladmin") {
      if (!isOwner)
        return await sock.sendMessage(
          remoteJid,
          { text: "❌ Only the owner can use this command." },
          { quoted: msg }
        );
      const quotedMsg =
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quotedMsg)
        return await sock.sendMessage(
          remoteJid,
          { text: "ℹ️ Please reply to a user's message to remove them." },
          { quoted: msg }
        );
      const targetJid = msg.message.extendedTextMessage.contextInfo.participant;
      if (!config.adminJids.includes(targetJid))
        return await sock.sendMessage(
          remoteJid,
          { text: "⚠️ This user is not an admin." },
          { quoted: msg }
        );
      config.adminJids = config.adminJids.filter((jid) => jid !== targetJid);
      saveConfig();
      await sock.sendMessage(
        remoteJid,
        { text: `✅ User has been demoted from admin.` },
        { quoted: msg }
      );
      console.log(`[-] ADMIN REMOVED: ${targetJid}`);
    }

    if (command === "!tag") {
      if (!isAuthorized)
        return await sock.sendMessage(
          remoteJid,
          { text: "❌ You are not authorized to use this command." },
          { quoted: msg }
        );
      if (!remoteJid.endsWith("@g.us"))
        return await sock.sendMessage(
          remoteJid,
          { text: "This command can only be used in a group." },
          { quoted: msg }
        );

      console.log(
        `[!] Authorized !tag from ${senderJid} in group ${remoteJid}`
      );
      try {
        const groupMetadata = await sock.groupMetadata(remoteJid);
        const participants = groupMetadata.participants;
        let mentionText = "👥 Tagging all members:\n";
        let mentionedJids = participants.map((p) => p.id);
        for (let participant of participants) {
          mentionText += `\n@${participant.id.split("@")[0]}`;
        }
        await sock.sendMessage(
          remoteJid,
          { text: mentionText, mentions: mentionedJids },
          { edit: msg.key }
        );
      } catch (err) {
        console.error("[X] Error during !tag:", err);
      }
    }

    if (command === "!htag") {
      if (!isAuthorized) return;
      if (remoteJid !== senderJid) {
        return await sock.sendMessage(
          remoteJid,
          {
            text: "ℹ️ Please use `!htag` in your private chat with me ('Message yourself').",
          },
          { quoted: msg }
        );
      }

      await sock.sendMessage(senderJid, {
        text: "Fetching your group list, this may take a moment...",
      });

      try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).sort((a, b) =>
          a.subject.localeCompare(b.subject)
        );

        if (groupList.length === 0)
          return await sock.sendMessage(senderJid, {
            text: "I am not a member of any groups.",
          });

        userState[senderJid] = {
          step: "awaiting_group_choice",
          data: groupList,
          currentPage: 1,
        };
        await displayGroupPage(sock, senderJid);
        console.log(
          `[HTAG] Started process for ${senderJid}. Displaying page 1.`
        );
      } catch (err) {
        console.error("[X] Error fetching groups for htag:", err);
        await sock.sendMessage(senderJid, {
          text: "❌ A fatal error occurred while fetching group list.",
        });
      }
    }
  });
}

startBot().catch((err) => {
  console.error("FATAL ERROR: Failed to start the bot:", err);
});
