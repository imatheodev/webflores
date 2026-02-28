// ============================================================
// FLORES & BOXES — Backend Completo
// Node.js + Express + MongoDB + MercadoPago + WhatsApp + Email
// ============================================================

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { OpenAI } = require('openai');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(bodyParser.json());
app.use(express.static('public')); // Sirve el frontend

// ===== CONFIG =====
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/floresboxes';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // MercadoPago Uruguay
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // whatsapp:+14155238886
const SMTP_HOST = process.env.SMTP_HOST; // smtp.brevo.com o Gmail
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const PORT = process.env.PORT || 3000;

// ===== DB CONNECTION =====
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ===== SCHEMAS =====
const OrderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  customer: {
    name: String, email: String, phone: String,
    address: String, barrio: String,
    deliveryDate: String, message: String,
  },
  items: [{ name: String, price: Number, emoji: String, qty: Number }],
  subtotal: Number,
  shipping: Number,
  total: Number,
  paymentMethod: String,
  paymentStatus: { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  orderStatus: { type: String, enum: ['pending','confirmed','preparing','shipped','delivered','cancelled'], default: 'pending' },
  mpPreferenceId: String,
  mpPaymentId: String,
  createdAt: { type: Date, default: Date.now },
});

const LeadSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  source: { type: String, default: 'website' },
  tags: [String],
  createdAt: { type: Date, default: Date.now },
});

const ChatSchema = new mongoose.Schema({
  phone: String,
  messages: [{ role: String, content: String, timestamp: Date }],
  updatedAt: { type: Date, default: Date.now },
});

const Order = mongoose.model('Order', OrderSchema);
const Lead = mongoose.model('Lead', LeadSchema);
const Chat = mongoose.model('Chat', ChatSchema);

// ===== MERCADOPAGO SETUP =====
const mpClient = new MercadoPagoConfig({
  accessToken: MP_ACCESS_TOKEN,
});
const mpPreference = new Preference(mpClient);
const mpPayment = new Payment(mpClient);

// ===== OPENAI SETUP =====
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== TWILIO SETUP =====
const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);

// ===== EMAIL SETUP =====
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ============================================================
// HELPER: Generate Order ID
// ============================================================
async function generateOrderId() {
  const count = await Order.countDocuments();
  return `#${String(count + 1).padStart(4, '0')}`;
}

// ============================================================
// HELPER: Send order confirmation email
// ============================================================
async function sendOrderEmail(order) {
  const itemsHtml = order.items.map(i =>
    `<tr><td>${i.emoji} ${i.name}</td><td>x${i.qty}</td><td>$${(i.price * i.qty).toLocaleString()} UYU</td></tr>`
  ).join('');

  await transporter.sendMail({
    from: `"Flores&Boxes" <${SMTP_USER}>`,
    to: order.customer.email,
    subject: `🌸 ¡Pedido confirmado! ${order.orderId} - Flores&Boxes`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#FDF0F3;border-radius:20px;overflow:hidden;">
        <div style="background:#C4607A;padding:32px;text-align:center;">
          <h1 style="color:white;font-size:28px;margin:0;">🌸 ¡Gracias, ${order.customer.name}!</h1>
          <p style="color:rgba(255,255,255,0.85);margin-top:8px;">Tu pedido fue confirmado</p>
        </div>
        <div style="padding:32px;">
          <p>Tu pedido <strong>${order.orderId}</strong> está en preparación con todo nuestro amor 💐</p>
          <h3 style="margin:24px 0 12px;">📦 Detalle del pedido</h3>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#FDE8EE;"><th style="padding:10px;text-align:left;">Producto</th><th>Cant.</th><th>Precio</th></tr></thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div style="margin-top:20px;padding:16px;background:white;border-radius:12px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>Subtotal</span><strong>$${order.subtotal.toLocaleString()} UYU</strong></div>
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>Envío</span><strong>${order.shipping === 0 ? 'Gratis 🎉' : '$'+order.shipping+' UYU'}</strong></div>
            <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:700;color:#C4607A;border-top:1px solid #eee;padding-top:12px;margin-top:6px;"><span>Total</span><span>$${order.total.toLocaleString()} UYU</span></div>
          </div>
          <div style="margin-top:20px;padding:16px;background:white;border-radius:12px;">
            <h4 style="margin-bottom:8px;">🚚 Datos de entrega</h4>
            <p>${order.customer.address}, ${order.customer.barrio}</p>
            <p>Fecha: ${order.customer.deliveryDate}</p>
            ${order.customer.message ? `<p>💌 Mensaje en tarjeta: "${order.customer.message}"</p>` : ''}
          </div>
          <div style="margin-top:28px;text-align:center;">
            <a href="https://wa.me/59899000000" style="background:#25D366;color:white;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:600;">💬 Consultar por WhatsApp</a>
          </div>
        </div>
        <div style="background:#2C2020;padding:20px;text-align:center;color:rgba(255,255,255,0.5);font-size:12px;">
          © 2025 Flores&Boxes · Montevideo, UY
        </div>
      </div>
    `,
  });
}

// ============================================================
// HELPER: Send admin notification
// ============================================================
async function notifyAdmin(order) {
  await transporter.sendMail({
    from: `"Flores&Boxes Sistema" <${SMTP_USER}>`,
    to: process.env.ADMIN_EMAIL,
    subject: `🛒 Nuevo pedido ${order.orderId} - $${order.total.toLocaleString()} UYU`,
    html: `
      <h2>Nuevo pedido recibido</h2>
      <p><strong>Cliente:</strong> ${order.customer.name} (${order.customer.email})</p>
      <p><strong>Teléfono:</strong> ${order.customer.phone}</p>
      <p><strong>Total:</strong> $${order.total.toLocaleString()} UYU</p>
      <p><strong>Método de pago:</strong> ${order.paymentMethod}</p>
      <p><strong>Entrega:</strong> ${order.customer.address}, ${order.customer.barrio} — ${order.customer.deliveryDate}</p>
      <p><strong>Productos:</strong> ${order.items.map(i => `${i.name} x${i.qty}`).join(', ')}</p>
    `,
  });
}

// ============================================================
//  ROUTES — ORDERS
// ============================================================

// POST /api/orders — Create order
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, paymentMethod } = req.body;
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const shipping = subtotal >= 2000 ? 0 : 150;
    const total = subtotal + shipping;
    const orderId = await generateOrderId();

    const order = new Order({
      orderId, customer, items, subtotal, shipping, total, paymentMethod,
    });

    if (paymentMethod === 'mercadopago') {
      // Create MercadoPago preference
      const preference = await mpPreference.create({
        body: {
          external_reference: orderId,
          items: items.map(i => ({
            id: i.name.replace(/\s/g, '_'),
            title: i.name,
            quantity: i.qty,
            currency_id: 'UYU',
            unit_price: i.price,
          })),
          payer: {
            name: customer.name,
            email: customer.email,
            phone: { number: customer.phone },
          },
          back_urls: {
            success: `${process.env.FRONTEND_URL}/success`,
            failure: `${process.env.FRONTEND_URL}/failure`,
            pending: `${process.env.FRONTEND_URL}/pending`,
          },
          auto_return: 'approved',
          notification_url: `${process.env.BACKEND_URL}/api/mp-webhook`,
          shipments: {
            cost: shipping,
            mode: 'not_specified',
          },
        },
      });

      order.mpPreferenceId = preference.id;
      await order.save();

      // Save lead
      await Lead.findOneAndUpdate(
        { email: customer.email },
        { name: customer.name, email: customer.email, source: 'checkout', tags: ['buyer'] },
        { upsert: true, new: true }
      );

      return res.json({
        success: true,
        orderId,
        mpInitPoint: preference.init_point, // Redirect here for payment
        preferenceId: preference.id,
      });
    }

    // Card payment (Stripe/dLocal for UY)
    order.paymentStatus = 'approved';
    order.orderStatus = 'confirmed';
    await order.save();

    await sendOrderEmail(order);
    await notifyAdmin(order);

    // Save lead
    await Lead.findOneAndUpdate(
      { email: customer.email },
      { name: customer.name, email: customer.email, source: 'checkout', tags: ['buyer'] },
      { upsert: true, new: true }
    );

    res.json({ success: true, orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders — List all (admin)
app.get('/api/orders', async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

// GET /api/orders/:id
app.get('/api/orders/:id', async (req, res) => {
  const order = await Order.findOne({ orderId: req.params.id });
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

// PATCH /api/orders/:id/status
app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const order = await Order.findOneAndUpdate(
    { orderId: req.params.id },
    { orderStatus: status },
    { new: true }
  );
  res.json(order);
});

// ============================================================
// MERCADOPAGO WEBHOOK
// ============================================================
app.post('/api/mp-webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment') {
      const payment = await mpPayment.get({ id: data.id });
      const orderId = payment.external_reference;

      const newStatus = payment.status === 'approved' ? 'approved'
        : payment.status === 'rejected' ? 'rejected' : 'pending';

      const order = await Order.findOneAndUpdate(
        { orderId },
        {
          paymentStatus: newStatus,
          mpPaymentId: String(data.id),
          orderStatus: newStatus === 'approved' ? 'confirmed' : 'pending',
        },
        { new: true }
      );

      if (order && newStatus === 'approved') {
        await sendOrderEmail(order);
        await notifyAdmin(order);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('MP webhook error:', err);
    res.sendStatus(500);
  }
});

// ============================================================
// ROUTES — LEADS
// ============================================================

// POST /api/leads
app.post('/api/leads', async (req, res) => {
  try {
    const { name, email } = req.body;
    const lead = await Lead.findOneAndUpdate(
      { email },
      { name, email, source: 'popup' },
      { upsert: true, new: true }
    );

    // Welcome email
    await transporter.sendMail({
      from: `"Flores&Boxes" <${SMTP_USER}>`,
      to: email,
      subject: '🌸 ¡Bienvenida a Flores&Boxes!',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
          <div style="background:#C4607A;padding:28px;text-align:center;border-radius:20px 20px 0 0;">
            <h1 style="color:white;margin:0;">🌸 ¡Hola, ${name}!</h1>
          </div>
          <div style="padding:28px;background:#FDF0F3;border-radius:0 0 20px 20px;">
            <p>Gracias por suscribirte. Pronto recibirás nuestras mejores ofertas y novedades.</p>
            <p style="margin-top:16px;">Como bienvenida, acá te dejamos <strong>10% OFF en tu primera compra</strong> con el código:</p>
            <div style="background:white;padding:16px;border-radius:12px;text-align:center;margin:20px 0;">
              <span style="font-size:24px;font-weight:700;color:#C4607A;letter-spacing:3px;">BIENVENIDA10</span>
            </div>
            <a href="${process.env.FRONTEND_URL}" style="display:block;background:#C4607A;color:white;text-align:center;padding:14px;border-radius:50px;text-decoration:none;font-weight:600;">Ver productos</a>
          </div>
        </div>
      `,
    });

    res.json({ success: true, lead });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true, message: 'Ya suscripto' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads — List all
app.get('/api/leads', async (req, res) => {
  const leads = await Lead.find().sort({ createdAt: -1 });
  res.json(leads);
});

// POST /api/leads/campaign — Send bulk email
app.post('/api/leads/campaign', async (req, res) => {
  try {
    const { subject, html, segment } = req.body;
    let query = {};
    if (segment === 'buyers') query = { tags: 'buyer' };
    if (segment === 'new') query = { tags: { $ne: 'buyer' } };

    const leads = await Lead.find(query);

    // Batch send (use Brevo/Mailchimp API in production for bulk)
    let sent = 0;
    for (const lead of leads) {
      await transporter.sendMail({
        from: `"Flores&Boxes" <${SMTP_USER}>`,
        to: lead.email,
        subject,
        html,
      });
      sent++;
    }

    res.json({ success: true, sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WHATSAPP BOT (via Twilio Webhooks)
// ============================================================

const PRODUCTS_CATALOG = [
  { name: 'Ramo Primaveral', price: 890, url: `${process.env.FRONTEND_URL}/#productos`, emoji: '💐' },
  { name: 'Box Romántica', price: 1590, url: `${process.env.FRONTEND_URL}/#productos`, emoji: '💝' },
  { name: '12 Rosas Rojas', price: 1290, url: `${process.env.FRONTEND_URL}/#productos`, emoji: '🌹' },
  { name: 'Box Spa & Relax', price: 1890, url: `${process.env.FRONTEND_URL}/#productos`, emoji: '🧴' },
  { name: 'Girasoles Alegres', price: 790, url: `${process.env.FRONTEND_URL}/#productos`, emoji: '🌻' },
  { name: 'Rosas Eternas Lila', price: 2490, url: `${process.env.FRONTEND_URL}/#productos`, emoji: '🌸' },
];

const SYSTEM_PROMPT = `Sos la asistente de Flores&Boxes, una floristería en Montevideo, Uruguay 🌸
Atendés por WhatsApp para ayudar a elegir flores y regalos especiales.

Nuestros productos:
${PRODUCTS_CATALOG.map(p => `- ${p.emoji} ${p.name}: $${p.price} UYU — Link: ${p.url}`).join('\n')}

Información importante:
- Envíos el mismo día en Montevideo
- Envío gratis para pedidos +$2.000 UYU
- Pagamos con MercadoPago, tarjeta de crédito y débito
- Entregamos de lunes a sábado de 9:00 a 19:00

Reglas:
1. Siempre respondé en español rioplatense con vos y voseo
2. Usá emojis 🌸💐🌹
3. Cuando alguien quiera comprar o preguntar por un producto específico, dales el link del producto
4. Si necesitan envío urgente, pediles dirección y acordá el horario
5. Sé cálida, amable y entusiasta
6. Si no podés resolver algo, deciles que los llamará un humano`;

app.post('/api/whatsapp-webhook', async (req, res) => {
  try {
    const { Body: userMsg, From: userPhone, ProfileName } = req.body;

    if (!userMsg || !userPhone) return res.sendStatus(200);

    // Load or create conversation
    let chat = await Chat.findOne({ phone: userPhone });
    if (!chat) {
      chat = new Chat({ phone: userPhone, messages: [] });
    }

    // Add user message
    chat.messages.push({ role: 'user', content: userMsg, timestamp: new Date() });

    // Keep last 20 messages for context
    const recentMessages = chat.messages.slice(-20).map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recentMessages,
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const botReply = completion.choices[0].message.content;

    // Save bot reply
    chat.messages.push({ role: 'assistant', content: botReply, timestamp: new Date() });
    chat.updatedAt = new Date();
    await chat.save();

    // Send via Twilio WhatsApp
    await twilioClient.messages.create({
      body: botReply,
      from: TWILIO_WHATSAPP_FROM,
      to: userPhone,
    });

    // Respond TwiML
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  } catch (err) {
    console.error('WhatsApp error:', err);
    res.sendStatus(500);
  }
});

// GET chat history (admin)
app.get('/api/chats', async (req, res) => {
  const chats = await Chat.find().sort({ updatedAt: -1 }).limit(50);
  res.json(chats);
});

// ============================================================
// ANALYTICS ENDPOINTS
// ============================================================
app.get('/api/analytics/summary', async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalOrders, monthOrders, totalLeads, monthLeads, revenueAgg] = await Promise.all([
    Order.countDocuments({ paymentStatus: 'approved' }),
    Order.countDocuments({ paymentStatus: 'approved', createdAt: { $gte: startOfMonth } }),
    Lead.countDocuments(),
    Lead.countDocuments({ createdAt: { $gte: startOfMonth } }),
    Order.aggregate([
      { $match: { paymentStatus: 'approved', createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: '$total' }, avg: { $avg: '$total' } } },
    ]),
  ]);

  const revenue = revenueAgg[0] || { total: 0, avg: 0 };

  res.json({
    totalOrders, monthOrders,
    totalLeads, monthLeads,
    monthRevenue: revenue.total,
    avgTicket: Math.round(revenue.avg),
  });
});

app.get('/api/analytics/revenue-weekly', async (req, res) => {
  const weeks = await Order.aggregate([
    { $match: { paymentStatus: 'approved' } },
    { $group: {
      _id: { $week: '$createdAt' },
      revenue: { $sum: '$total' },
      orders: { $sum: 1 },
    }},
    { $sort: { '_id': -1 } },
    { $limit: 8 },
  ]);
  res.json(weeks.reverse());
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🌸 Flores&Boxes Backend running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`🛒 Tienda:    http://localhost:${PORT}/index.html`);
});

module.exports = app;
