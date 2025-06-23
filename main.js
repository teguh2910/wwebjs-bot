const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios'); // Diperlukan untuk memanggil API Laravel
const cron = require('node-cron'); // Import node-cron

// --- PENTING: Import Google Cloud Dialogflow SDK ---
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid');

require('dotenv').config();

// --- Konfigurasi Google Cloud/Dialogflow dari .env ---
const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;

if (!GOOGLE_CLOUD_PROJECT_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn('Peringatan: Kredensial Dialogflow tidak lengkap. Mode interaktif mungkin tidak berfungsi penuh.');
}

const sessionClient = GOOGLE_CLOUD_PROJECT_ID && process.env.GOOGLE_APPLICATION_CREDENTIALS ? 
    new dialogflow.SessionsClient({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS }) : null;

// --- Konfigurasi API Laravel dan Reminder dari .env ---
const LARAVEL_API_BASE_URL = process.env.LARAVEL_API_BASE_URL; // URL API Laravel
const WHATSAPP_REMINDER_GROUP_JID = process.env.WHATSAPP_REMINDER_GROUP_JID; // JID grup target reminder

if (!LARAVEL_API_BASE_URL || !WHATSAPP_REMINDER_GROUP_JID) {
    console.error('Error: LARAVEL_API_BASE_URL atau WHATSAPP_REMINDER_GROUP_JID tidak didefinisikan di .env file!');
    console.error('Reminder otomatis tidak akan berfungsi.');
    // Tidak exit, biarkan bot tetap berjalan untuk interaktif
}

// --- Inisialisasi WhatsApp Client ---
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
    console.log('Mode Interaktif: Bot siap menjawab pertanyaan.');
    console.log('Pastikan untuk menambahkan bot ke grup dan mention bot agar merespons.');

    // --- JADWALKAN REMINDER INTERNAL DI BOT WHATSAPP ---
    console.log(`Menjadwalkan reminder stok kritis ke grup ${WHATSAPP_REMINDER_GROUP_JID} setiap hari jam 08:00 WIB.`);
    
    // Sesuaikan cron schedule string jika zona waktu server berbeda
    // Cron string: menit jam hari_bulan bulan hari_minggu
    // '0 8 * * *' berarti jam 08:00 setiap hari
    cron.schedule('* * * * *', async () => {
        console.log('Memicu pengiriman reminder stok kritis terjadwal...');
        if (!client.info.wid._serialized) { // Cek apakah bot masih terhubung
            console.error('Client WhatsApp belum siap untuk mengirim reminder. Melewatkan jadwal.');
            return;
        }

        try {
            // Panggil API Laravel untuk mendapatkan daftar stok kritis
            const response = await axios.post(`${LARAVEL_API_BASE_URL}/api/chatbot/urgent-stocks`);

            let reminderContent;
            if (response.data.status === 'success') {
                reminderContent = response.data.answer;
            } else {
                reminderContent = 'Maaf, terjadi kesalahan saat mengambil daftar stok kritis dari sistem. ' + response.data.message;
                console.error('API Error saat jadwal reminder:', response.data.message);
            }

            // Tambahkan header khusus untuk reminder
            const finalReminderMessage = `🔔 *Pengingat Stok Kritis Hari Ini* 🔔\n\n${reminderContent}\n\nSegera periksa material-material ini di aplikasi!`;

            // Kirim pesan ke grup target
            const chat = await client.getChatById(WHATSAPP_REMINDER_GROUP_JID);
            if (chat) {
                const sentMessage = await chat.sendMessage(finalReminderMessage);
                if (sentMessage && sentMessage.id) {
                    console.log('Reminder stok kritis berhasil dikirim secara terjadwal.');
                } else {
                    console.error('Error: Reminder tidak mendapatkan ID pesan setelah dikirim.');
                }
            } else {
                console.error('Error: Grup reminder (JID) tidak ditemukan.');
            }

        } catch (error) {
            console.error('Error saat menjalankan jadwal reminder:', error.message);
            if (error.response) {
                console.error('API Laravel Response Data (Reminder):', error.response.data);
                console.error('API Laravel Response Status (Reminder):', error.response.status);
            }
        }
    }, {
        timezone: "Asia/Jakarta" // Penting! Sesuaikan dengan zona waktu server Anda (misal: "Asia/Jakarta" untuk WIB)
    });
});

// --- LISTENER PESAN INTERAKTIF (Sama seperti sebelumnya) ---
client.on('message', async msg => {
    const chat = await msg.getChat();

    if (chat.isGroup) {
        const botId = client.info.wid._serialized;
        const isBotMentioned = msg.mentionedIds.includes(botId);
        if (!isBotMentioned) {
            return;
        }
    }

    let rawText = msg.body;
    let cleanedText = rawText.replace(/\b\d{10,15}@c\.us\b/g, '')
                            .replace(/@\d{10,15}\s?/g, '')
                            .replace(/\u200e/g, '')
                            .replace(/\u00a0/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
    
    if (!cleanedText) {
        return;
    }

    if (!sessionClient) {
        msg.reply('Maaf, bot tidak dapat memproses pertanyaan karena konfigurasi Dialogflow tidak lengkap. Mohon hubungi administrator.');
        return;
    }
    
    const sessionId = msg.from;
    const sessionPath = sessionClient.projectAgentSessionPath(GOOGLE_CLOUD_PROJECT_ID, sessionId);

    const request = {
        session: sessionPath,
        queryInput: {
            text: {
                text: cleanedText,
                languageCode: 'id',
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

client.on('disconnected', (reason) => {
    console.log('WhatsApp Bot terputus!', reason);
    // Ini penting agar proses tidak nyangkut jika terputus
    process.exit(1); 
});

client.initialize();