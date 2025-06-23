const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
// const axios = require('axios'); // Axios TIDAK DIGUNAKAN untuk memanggil API Dialogflow secara langsung lagi

// --- PENTING: Import Google Cloud Dialogflow SDK ---
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid'); // Digunakan untuk membuat session ID unik (jika tidak menggunakan msg.from)

// Load environment variables from .env file
require('dotenv').config();

// --- Konfigurasi Google Cloud/Dialogflow dari .env ---
// Pastikan Anda sudah menyiapkan ini di .env proyek bot Anda:
// GOOGLE_APPLICATION_CREDENTIALS=./path/to/your/google-credentials.json
// GOOGLE_CLOUD_PROJECT_ID=your-google-cloud-project-id
// DIALOGFLOW_AGENT_ID=your-dialogflow-agent-id (ini bisa sama dengan project ID)

const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID;
// const DIALOGFLOW_AGENT_ID = process.env.DIALOGFLOW_AGENT_ID; // Agent ID seringkali sama dengan Project ID untuk penggunaan dasar

// Pastikan variabel lingkungan krusial terdefinisi
if (!GOOGLE_CLOUD_PROJECT_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Error: GOOGLE_CLOUD_PROJECT_ID atau GOOGLE_APPLICATION_CREDENTIALS tidak terdefinisi di .env file!');
    process.exit(1);
}

// Inisialisasi Dialogflow SessionClient
const sessionClient = new dialogflow.SessionsClient({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS // Menggunakan path ke file kredensial JSON
});

// --- Inisialisasi WhatsApp Client ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

client.on('qr', qr => {
    console.log('WA Bot tidak terhubung. Pindai QR code ini dengan aplikasi WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp Bot siap digunakan!');
    console.log('Pastikan untuk menambahkan bot ke grup dan mention bot agar merespons.');
});

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
    
    // Jika teks kosong setelah pembersihan (misal hanya mention), bisa diabaikan
    if (!cleanedText) {
        return;
    }

    // --- LOGIKA MENGIRIM PESAN KE DIALOGFLOW MENGGUNAKAN SDK ---
    // Gunakan ID pengirim sebagai session ID untuk melacak percakapan per pengguna
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
        // Anda bisa menambahkan queryParams di sini jika ada niat untuk mengirim custom payload ke fulfillment
        // queryParams: {
        //     payload: {
        //         fields: {
        //             whatsappUserId: { stringValue: msg.from, kind: 'stringValue' },
        //         },
        //     },
        // },
    };

    try {
        console.log(`Mengirim pesan ke Dialogflow: "${cleanedText}" untuk sesi ${sessionId}`);
        const responses = await sessionClient.detectIntent(request);
        const result = responses[0].queryResult;

        // Ambil fulfillmentText dari Dialogflow.
        // Jika webhook fulfillment berhasil, ini akan berisi respons dari Laravel Anda.
        let replyMessage = result.fulfillmentText;

        if (!replyMessage && result.intent && result.intent.displayName) {
            // Ini akan terjadi jika Dialogflow berhasil mengidentifikasi intent
            // tetapi webhook fulfillment Laravel gagal merespons dengan fulfillmentText
            // atau intent tidak memiliki respons teks default di Dialogflow
            console.warn(`Intent "${result.intent.displayName}" terdeteksi, tetapi fulfillmentText kosong. Cek log webhook Anda.`);
            replyMessage = `Saya mengerti maksud Anda "${result.intent.displayName}", tetapi ada masalah saat mengambil informasi.`;
        } else if (!replyMessage) {
            // Jika Dialogflow sama sekali tidak mengerti (Default Fallback Intent)
            replyMessage = "Maaf, saya tidak mengerti. Bisakah Anda mengulanginya dengan cara lain?";
        }
        
        // --- OPSIONAL: Tangani Custom Payload dari Dialogflow (jika Laravel mengirimnya) ---
        // Jika Laravel Anda mengirim balasan dalam payload kustom (misalnya untuk WhatsApp), Anda bisa tangani di sini
        // if (result.webhookPayload && result.webhookPayload.fields && result.webhookPayload.fields.whatsapp && result.webhookPayload.fields.whatsapp.stringValue) {
        //     replyMessage = result.webhookPayload.fields.whatsapp.stringValue;
        // }


        msg.reply(replyMessage); // Kirim balasan ke WhatsApp

    } catch (error) {
        console.error('Error saat memanggil Dialogflow API:', error.message);
        // Penting: Di sini kita menangani error saat menghubungi API Dialogflow itu sendiri,
        // BUKAN error dari webhook fulfillment Laravel.
        if (error.code === 7 || error.code === 14) { // UNAUTHENTICATED or UNAVAILABLE
            msg.reply('Maaf, bot tidak dapat terhubung ke layanan Dialogflow. Pastikan kredensial dan koneksi internet bot sudah benar.');
        } else {
            msg.reply('Maaf, ada masalah saat memproses permintaan Anda. Silakan coba lagi nanti.');
        }
    }
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp Bot terputus!', reason);
});

client.initialize();