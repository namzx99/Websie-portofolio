const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const WebSocket = require('ws');
const http = require('http');

// Load env (prefer project root) so EMAIL_USER/EMAIL_PASS always available
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath });


const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('./'));

// Setup Email (optional)
let transporter = null;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

function normalizeEnv(v) {
  return (v ?? '').toString().trim();
}

const emailUser = normalizeEnv(EMAIL_USER);
const emailPass = normalizeEnv(EMAIL_PASS);

// Diagnostic (mask password)
console.log('[Email SMTP] EMAIL_USER set:', Boolean(emailUser));
console.log('[Email SMTP] EMAIL_PASS set:', Boolean(emailPass));

const emailReady = Boolean(emailUser && emailPass);
if (emailReady) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailUser,
      pass: emailPass,
    },
    // Extra TLS options for reliability
    secure: true,
    tls: {
      rejectUnauthorized: false,
    },
  });
}


// In-memory store (simple persistence for this project)
const feedbackStore = [];
const adminConnections = new Set(); // WebSocket connections dari admin.html

// Create HTTP server untuk WebSocket
const server = http.createServer(app);

/**
 * Feedback model (shape expected by admin.html):
 * {
 *   _id: string,
 *   name: string,
 *   email: string,
 *   subject: string,
 *   message: string,
 *   status: 'pending' | 'responded',
 *   createdAt: string | Date
 * }
 */

// Setup WebSocket Server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('🔗 Admin connected (WebSocket)');
  adminConnections.add(ws);

  ws.on('close', () => {
    console.log('❌ Admin disconnected');
    adminConnections.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('WS Error:', err.message);
  });
});

// Function: Broadcast new feedback ke semua admin yang terkoneksi
function broadcastToAdmins(event, data) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  adminConnections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// Routes

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server running ✅' });
});

// Submit Contact Form
app.post('/api/send-email', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    // Validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: 'Semua field harus diisi!',
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({
        success: false,
        message: 'Email tidak valid!',
      });
    }

    // Persist to store so admin.html can show it
    const feedback = {
      _id: crypto.randomUUID(),
      name: String(name).trim(),
      email: String(email).trim(),
      subject: String(subject).trim(),
      message: String(message).trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    feedbackStore.push(feedback);

    // 🔴 BROADCAST ke admin.html via WebSocket (real-time notification)
    broadcastToAdmins('new_feedback', feedback);

    // Send email (optional)
    // Guard keras: jangan pernah panggil transporter.sendMail kalau kredensial kosong.
    const emailReadyNow = Boolean(normalizeEnv(process.env.EMAIL_USER) && normalizeEnv(process.env.EMAIL_PASS));

    if (emailReadyNow && transporter) {
      // Send to user (acknowledgement)

      await transporter.sendMail({

        from: process.env.EMAIL_USER,
        to: feedback.email,
        subject: `Terima kasih: ${feedback.subject}`,
        html: `
          <div style="font-family: Arial; color: #333; line-height: 1.6; max-width: 600px;">
            <h2 style="color: #3b82f6;">Halo ${feedback.name}! 👋</h2>
            <p>Kami telah menerima pesan Anda. Terima kasih telah menghubungi kami!</p>
            <div style="background: #f0f0f0; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Subject:</strong> ${feedback.subject}</p>
              <p><strong>Message:</strong> ${feedback.message}</p>
            </div>
            <p>Kami akan merespon dalam 24 jam. Terima kasih! 🙏</p>
          </div>
        `,
      });

      // Send to admin
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: `📧 Pesan Baru dari ${feedback.name}`,
        html: `
          <div style="font-family: Arial; color: #333;">
            <h2>Pesan Masuk dari Portfolio</h2>
            <p><strong>Nama:</strong> ${feedback.name}</p>
            <p><strong>Email:</strong> ${feedback.email}</p>
            <p><strong>Subject:</strong> ${feedback.subject}</p>
            <hr>
            <p>${feedback.message}</p>
          </div>
        `,
      });
    }


    const skipped = !emailReadyNow;
    res.json({
      success: true,
      message: 'Pesan telah terkirim! ✅',
      feedbackId: feedback._id,
      emailSkipped: skipped,
      emailSkipReason: skipped ? 'SMTP email belum dikonfigurasi (EMAIL_USER/EMAIL_PASS kosong).' : undefined,
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    // Jangan gagal total kalau emailnya error, karena fitur utama adalah masuk ke admin via store/WS.
    res.json({
      success: true,
      message: 'Pesan berhasil terkirim! ✅',
      feedbackId: feedback?._id,
    });
  }
});

// Admin endpoints (used by admin.html)
app.get('/api/feedback', (req, res) => {
  res.json({ data: feedbackStore.slice().reverse() });
});

app.put('/api/feedback/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['pending', 'responded'].includes(String(status).toLowerCase())) {
      return res.status(400).json({ message: 'Status tidak valid. Gunakan pending atau responded.' });
    }

    const item = feedbackStore.find((f) => f._id === id);
    if (!item) {
      return res.status(404).json({ message: 'Feedback tidak ditemukan.' });
    }

    item.status = String(status).toLowerCase();
    
    // Broadcast update to all admins
    broadcastToAdmins('feedback_updated', item);
    
    res.json({ success: true, data: item });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: 'Gagal update feedback.' });
  }
});

app.delete('/api/feedback/:id', (req, res) => {
  try {
    const { id } = req.params;
    const index = feedbackStore.findIndex((f) => f._id === id);

    if (index === -1) {
      return res.status(404).json({ message: 'Feedback tidak ditemukan.' });
    }

    feedbackStore.splice(index, 1);
    
    // Broadcast deletion to all admins
    broadcastToAdmins('feedback_deleted', { _id: id });
    
    res.json({ success: true });
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: 'Gagal menghapus feedback.' });
  }
});

// Start Server
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════╗
║   🚀 Server Running               ║
║   📧 Email: ${process.env.EMAIL_USER ? 'Ready ✅' : 'Not configured'}
║   🔌 WebSocket: Ready ✅
║   Port: ${PORT}
║   URL: http://localhost:${PORT}
║   WS: ws://localhost:${PORT}
╚════════════════════════════════════╝
    `);
});

module.exports = app;
