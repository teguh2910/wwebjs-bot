const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
// const axios = require('axios'); // Hapus jika tidak digunakan

const dialogflow = require('@google-cloud/dialogflow'); // Hapus jika tidak digunakan
const uuid = require('uuid'); // Hapus jika tidak digunakan

require('dotenv').config();

const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;

if (!GOOGLE_CLOUD_PROJECT_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn('Peringatan: Kredensial Dialogflow tidak lengkap. Mode interaktif mungkin tidak berfungsi penuh.');
}

const sessionClient = GOOGLE_CLOUD_PROJECT_ID && process.env.GOOGLE_APPLICATION_CREDENTIALS ? 
    new dialogflow.SessionsClient({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS }) : null;

const mode = process.argv[2];
const targetId = process.argv[3];
const reminderMessage = process.argv[4];

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
        ],
        headless: true, // <-- Pastikan ini TRUE untuk server/produksi
        timeout: 60000
    }
});

client.on('qr', qr => {
    console.log('WA Bot tidak terhubung. Pindai QR code ini dengan aplikasi WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('WhatsApp Bot siap digunakan!');

    if (mode === 'reminder' && targetId && reminderMessage) {
        console.log(`Mode Reminder: Mencoba mengirim pesan ke ${targetId}...`);
        
        try {
            // Tunggu sebentar untuk memastikan sesi stabil SEBELUM mencoba kirim
            await new Promise(resolve => setTimeout(resolve, 3000)); // Tunggu 3 detik

            const chat = await client.getChatById(targetId); // Coba lagi dapatkan objek chat
            if (!chat) {
                console.error(`Error: Target chat (ID ${targetId}) tidak ditemukan.`);
                client.destroy();
                process.exit(1);
            }

            // --- PENGIRIMAN PESAN DAN PENUNDAAN KELUAR YANG LEBIH BAIK ---
            const sentMessage = await client.sendMessage(targetId, reminderMessage);
            
            if (sentMessage && sentMessage.id && sentMessage.id.fromMe) {
                console.log('Pesan reminder berhasil di-queue untuk dikirim:', sentMessage.id._serialized);
                // Tunggu beberapa detik lagi setelah pesan dianggap terkirim
                // untuk memberi waktu WhatsApp memproses pengiriman aktual
                await new Promise(resolve => setTimeout(resolve, 5000)); // Tunggu 5 detik tambahan
                console.log('Penundaan selesai. Mematikan bot untuk mode reminder...');
                client.destroy();
                process.exit(0);
            } else {
                console.error('Error: Pesan tidak mendapatkan konfirmasi ID yang valid setelah dikirim.');
                console.error('Response pengiriman:', sentMessage);
                client.destroy();
                process.exit(1);
            }
        } catch (error) {
            console.error('Terjadi kesalahan saat mengirim pesan reminder:', error.message);
            if (error.message.includes("Message failed to send")) {
                console.error("Pesan gagal dikirim oleh WhatsApp API. Cek izin bot di grup atau nomor tujuan.");
            } else if (error.message.includes("Timed out")) {
                console.error("Pengiriman timeout. Koneksi mungkin tidak stabil.");
            } else if (error.message.includes("Evaluation failed:")) {
                 console.error("Puppeteer/Browser error. Coba headless: false untuk debug visual.");
            }
            client.destroy();
            process.exit(1);
        }

    } else {
        // --- LOGIKA MODE INTERAKTIF (Default) ---
        console.log('Mode Interaktif: Bot siap menjawab pertanyaan.');
        console.log('Pastikan untuk menambahkan bot ke grup dan mention bot agar merespons.');
    }
});
// --- HANYA AKTIFKAN LISTENER PESAN JIKA DALAM MODE INTERAKTIF ---
if (mode !== 'reminder') {
    client.on('message', async msg => {
        const chat = await msg.getChat();

        // Logika untuk merespons hanya jika di-mention di grup atau di private chat
        if (chat.isGroup) {
            const botId = client.info.wid._serialized;
            const isBotMentioned = msg.mentionedIds.includes(botId);
            if (!isBotMentioned) {
                return;
            }
        }

        let rawText = msg.body;
        // Bersihkan mention dan karakter aneh lainnya
        let cleanedText = rawText.replace(/\b\d{10,15}@c\.us\b/g, '')
                                .replace(/@\d{10,15}\s?/g, '')
                                .replace(/\u200e/g, '')
                                .replace(/\u00a0/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim();
        
        if (!cleanedText) {
            return;
        }

        // --- LOGIKA MENGIRIM PESAN KE DIALOGFLOW MENGGUNAKAN SDK ---
        const sessionId = msg.from; // ID pengirim pesan sebagai session ID Dialogflow
        const sessionPath = sessionClient.projectAgentSessionPath(GOOGLE_CLOUD_PROJECT_ID, sessionId);

        const request = {
            session: sessionPath,
            queryInput: {
                text: {
                    text: cleanedText,
                    languageCode: 'id', // Pastikan ini sesuai dengan bahasa Agent Dialogflow Anda
                },
            },
        };

        try {
            console.log(`Mengirim pesan ke Dialogflow: "${cleanedText}" untuk sesi ${sessionId}`);
            const responses = await sessionClient.detectIntent(request);
            const result = responses[0].queryResult;

            let replyMessage = result.fulfillmentText;

            if (!replyMessage && result.intent && result.intent.displayName) {
                console.warn(`Intent "${result.intent.displayName}" terdeteksi, tetapi fulfillmentText kosong. Cek log webhook Anda.`);
                replyMessage = `Saya mengerti maksud Anda "${result.intent.displayName}", tetapi ada masalah saat mengambil informasi.`;
            } else if (!replyMessage) {
                replyMessage = "Maaf, saya tidak mengerti. Bisakah Anda mengulanginya dengan cara lain?";
            }
            
            msg.reply(replyMessage);

        } catch (error) {
            console.error('Error saat memanggil Dialogflow API:', error.message);
            if (error.code === 7 || error.code === 14) {
                msg.reply('Maaf, bot tidak dapat terhubung ke layanan Dialogflow. Pastikan kredensial dan koneksi internet bot sudah benar.');
            } else {
                msg.reply('Maaf, ada masalah saat memproses permintaan Anda. Silakan coba lagi nanti.');
            }
        }
    });
}


// Ini penting untuk memastikan listener 'disconnected' juga mematikan proses saat tidak sengaja terputus
client.on('disconnected', (reason) => {
    console.log('WhatsApp Bot terputus!', reason);
    process.exit(1); // Keluar dengan kode error jika terputus
});

client.initialize();