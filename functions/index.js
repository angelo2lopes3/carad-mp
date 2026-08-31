/**
 * ============================================================================
 * Cloud Functions — Checkout Transparente Mercado Pago (Site Calourada)
 * ============================================================================
 *
 * Por que isso precisa existir como um backend (e não pode ficar no HTML):
 *   O Access Token do Mercado Pago é uma chave SECRETA. Se ela fosse colocada
 *   no código do site (HTML/JS do navegador), qualquer visitante conseguiria
 *   copiá-la pelo "Inspecionar elemento" e usá-la para acessar sua conta do
 *   Mercado Pago inteira (ver todos os pagamentos, criar reembolsos, etc).
 *   Por isso, só o servidor (estas Cloud Functions) conhece o Access Token.
 *   O navegador só conhece a chave PÚBLICA, que não dá nenhum poder sozinha.
 *
 * O que cada função faz:
 *   - criarPagamentoPix      : cria o ingresso (pendente) + o pagamento Pix
 *                              no Mercado Pago, devolve o QR Code ao site.
 *   - criarPagamentoCartao   : cria o ingresso (pendente) + processa o
 *                              pagamento com cartão (usando o token gerado
 *                              pelo Card Brick no navegador — o número do
 *                              cartão em si NUNCA passa pelo nosso servidor).
 *   - consultarStatusIngresso: usado pelo site para saber se o Pix já foi
 *                              aprovado. Além de ler o Firestore, esta
 *                              função também CONSULTA A API DO MERCADO PAGO
 *                              diretamente (usando o paymentId salvo) e
 *                              atualiza o ingresso na hora — é isso que faz
 *                              a aprovação do Pix ser automática mesmo que
 *                              o webhook não esteja configurado/chegando.
 *   - mercadoPagoWebhook     : recebe a confirmação assíncrona do Mercado
 *                              Pago (uma segunda via de aprovação automática,
 *                              mais rápida quando funciona). Valida a
 *                              assinatura (x-signature) para garantir que a
 *                              notificação realmente veio do Mercado Pago —
 *                              sem isso, qualquer pessoa poderia "fingir" um
 *                              pagamento aprovado só chamando essa URL.
 *
 * Assim que um ingresso é aprovado (por qualquer um dos três caminhos acima),
 * é enviado automaticamente um e-mail para o comprador com o PDF do
 * ingresso anexado (função enviarEmailIngresso). Um campo "emailSent" no
 * documento do ingresso evita que o e-mail seja disparado mais de uma vez.
 *
 * IMPORTANTE — o valor cobrado NUNCA vem do navegador. Todas as funções
 * buscam o preço do produto direto no Firestore (calourada/content) usando
 * o itemId enviado pelo cliente, então não dá para um visitante alterar o
 * preço pela rede (ex.: via DevTools) e pagar menos do que deveria.
 *
 * ---------------------------------------------------------------------------
 * COMO CONFIGURAR (rode esses comandos na pasta que contém "functions/"):
 *
 *   firebase functions:secrets:set MP_ACCESS_TOKEN
 *     -> cole o Access Token de PRODUÇÃO (ou de teste) do Mercado Pago
 *
 *   firebase functions:secrets:set MP_WEBHOOK_SECRET
 *     -> cole a "Chave secreta" mostrada em:
 *        Mercado Pago > Suas integrações > (sua aplicação) > Webhooks
 *
 *   firebase functions:secrets:set EMAIL_HOST      (ex: smtp.gmail.com)
 *   firebase functions:secrets:set EMAIL_PORT      (ex: 465)
 *   firebase functions:secrets:set EMAIL_USER      (seu e-mail de envio)
 *   firebase functions:secrets:set EMAIL_PASS      (senha de app do e-mail)
 *
 *   cd functions && npm install
 *
 *   firebase deploy --only functions
 *
 * Depois do deploy, pegue a URL da função "mercadoPagoWebhook" (aparece no
 * terminal, algo como https://southamerica-east1-SEU-PROJETO.cloudfunctions.net/mercadoPagoWebhook)
 * e cadastre-a no painel do Mercado Pago em:
 *   Suas integrações > (sua aplicação) > Webhooks > Configurar notificações
 *   -> marque o evento "Pagamentos"
 * ============================================================================
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

admin.initializeApp();
const db = admin.firestore();

const REGION = "southamerica-east1";
const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");
const EMAIL_HOST = defineSecret("EMAIL_HOST");
const EMAIL_PORT = defineSecret("EMAIL_PORT");
const EMAIL_USER = defineSecret("EMAIL_USER");
const EMAIL_PASS = defineSecret("EMAIL_PASS");
const EMAIL_SECRETS = [EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS];

function getMpClient() {
  return new MercadoPagoConfig({
    accessToken: MP_ACCESS_TOKEN.value(),
    options: { timeout: 8000 },
  });
}

// Mesma lógica usada no index.html só para exibir o valor — aqui é a fonte
// de verdade real, o preço que efetivamente será cobrado.
function parseBRLPrice(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[^\d,.-]/g, "");
  const normalized = cleaned.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : val;
}

function onlyDigits(str) {
  return String(str || "").replace(/\D/g, "");
}

function isValidEmail(str) {
  return typeof str === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function genTicketId() {
  return "T-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

// ============================================================================
// PDF do ingresso (gerado no servidor, para anexar ao e-mail) + envio de
// e-mail. Visual mais simples que o PDF do painel admin (gerado no
// navegador com jsPDF), mas com as mesmas informações essenciais.
// ============================================================================
async function gerarPdfIngressoBuffer(ticket) {
  const qrDataUrl = await QRCode.toDataURL(ticket.id, { margin: 1, width: 300 });
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [539, 255], margin: 0 }); // ~190x90mm em pontos
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // fundo escuro
    doc.rect(0, 0, 539, 255).fill("#0A0D13");
    // faixa lateral ciano
    doc.rect(0, 0, 11, 255).fill("#6FD9EC");

    doc.fillColor("#E8A23C").fontSize(13).font("Helvetica-Bold")
      .text("INGRESSO OFICIAL", 34, 30);
    doc.fillColor("#8B94A6").fontSize(15)
      .text(String(ticket.eventName || "Evento").toUpperCase(), 34, 55, { width: 300 });
    doc.fillColor("#F3EEE2").fontSize(28).font("Helvetica-Bold")
      .text(String(ticket.name || ""), 34, 95, { width: 300 });
    doc.fillColor("#8B94A6").fontSize(13).font("Helvetica")
      .text(String(ticket.phone || "Sem telefone"), 34, 132);
    doc.fillColor("#6FD9EC").fontSize(15).font("Courier")
      .text("CÓDIGO: " + String(ticket.id), 34, 158);

    doc.roundedRect(34, 182, 90, 26, 4).fill("#2F6B4E");
    doc.fillColor("#FFFFFF").fontSize(11).font("Helvetica-Bold")
      .text("VÁLIDO", 34, 189, { width: 90, align: "center" });

    doc.fillColor("#8B94A6").fontSize(9).font("Courier")
      .text("Emitido em: " + new Date().toLocaleDateString("pt-BR"), 34, 228);

    // QR code (com fundo branco / zona de silêncio)
    const qrSize = 105, qrX = 400, qrY = 40;
    doc.roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 4).fill("#FFFFFF");
    doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
    doc.fillColor("#8B94A6").fontSize(8).font("Helvetica")
      .text("Apresente este QR code", qrX - 10, qrY + qrSize + 22, { width: qrSize + 20, align: "center" })
      .text("na entrada do evento.", qrX - 10, qrY + qrSize + 32, { width: qrSize + 20, align: "center" });

    doc.end();
  });
}

function getMailTransport() {
  return nodemailer.createTransport({
    host: EMAIL_HOST.value(),
    port: Number(EMAIL_PORT.value()) || 465,
    secure: Number(EMAIL_PORT.value()) !== 587, // 465 = SSL direto; 587 = STARTTLS
    auth: { user: EMAIL_USER.value(), pass: EMAIL_PASS.value() },
  });
}

async function enviarEmailIngresso(ticket) {
  if (!ticket.email) return;
  try {
    const pdfBuffer = await gerarPdfIngressoBuffer(ticket);
    const transport = getMailTransport();
    await transport.sendMail({
      from: `"Calourada" <${EMAIL_USER.value()}>`,
      to: ticket.email,
      subject: `🎟️ Seu ingresso — ${ticket.eventName || "Evento"}`,
      text:
        `Olá, ${ticket.name}!\n\n` +
        `Seu pagamento foi aprovado e seu ingresso para "${ticket.eventName}" está confirmado.\n\n` +
        `Código do ingresso: ${ticket.id}\n\n` +
        `O ingresso em PDF (com QR code para entrada) está anexado a este e-mail.\n\n` +
        `Até lá!`,
      attachments: [
        { filename: `ingresso_${ticket.id}.pdf`, content: pdfBuffer, contentType: "application/pdf" },
      ],
    });
    logger.info(`E-mail de ingresso enviado para ${ticket.email} (ticket ${ticket.id})`);
  } catch (e) {
    // Falha no envio de e-mail nunca deve derrubar a aprovação do pagamento.
    logger.error(`Erro ao enviar e-mail do ingresso ${ticket.id}`, e);
  }
}

/**
 * Ponto único que decide o novo status de um ingresso a partir do status
 * retornado pelo Mercado Pago, grava no Firestore e dispara o e-mail quando
 * o ingresso é aprovado — usado tanto pela checagem ativa (polling) quanto
 * pelo webhook, evitando código duplicado e envios de e-mail repetidos.
 */
async function finalizarStatusIngresso(ticketRef, ticketDataAtual, mpStatus, mpStatusDetail, mpPaymentId) {
  const updates = {
    paymentStatus: mpStatus,
    paymentStatusDetail: mpStatusDetail || null,
  };
  if (mpPaymentId) updates.paymentId = String(mpPaymentId);

  let novoStatus = ticketDataAtual.status;
  if (mpStatus === "approved") novoStatus = "approved";
  else if (mpStatus === "rejected" || mpStatus === "cancelled") novoStatus = "rejected";

  const jaEnviouEmail = !!ticketDataAtual.emailSent;
  const vaiAprovarAgora = novoStatus === "approved" && ticketDataAtual.status !== "approved";

  if (novoStatus !== ticketDataAtual.status) updates.status = novoStatus;

  if (novoStatus === "approved" && !jaEnviouEmail) {
    updates.emailSent = true;
  }

  await ticketRef.update(updates);

  if (novoStatus === "approved" && !jaEnviouEmail) {
    await enviarEmailIngresso({ ...ticketDataAtual, ...updates, status: novoStatus });
  }

  return novoStatus;
}

/**
 * Busca o item da loja/ingresso e o nome do evento diretamente no Firestore,
 * nunca confiando em nome/preço enviados pelo cliente.
 */
async function lookupItemAndEvent(itemId, eventId) {
  const contentSnap = await db.collection("calourada").doc("content").get();
  if (!contentSnap.exists) {
    throw new HttpsError("failed-precondition", "Conteúdo do site não encontrado.");
  }
  const content = contentSnap.data() || {};
  const shopItems = content.shopItems || [];
  const events = content.events || [];

  const item = shopItems.find((x) => x.id === itemId);
  if (!item) {
    throw new HttpsError("not-found", "Produto/ingresso não encontrado.");
  }
  const amount = parseBRLPrice(item.price);
  if (!amount || amount <= 0) {
    throw new HttpsError("failed-precondition", "Este item não possui um preço válido.");
  }

  let eventName = "Loja - " + item.title;
  if (item.isTicket) {
    const ev = events.find((e) => e.id === (item.eventId || eventId));
    eventName = ev ? ev.name : "Evento";
  }

  return { item, amount, eventName, eventId: item.isTicket ? item.eventId : null };
}

function validateBuyerFields({ name, phone }) {
  if (!name || typeof name !== "string" || !name.trim() || name.trim().length > 200) {
    throw new HttpsError("invalid-argument", "Nome inválido.");
  }
  if (!phone || typeof phone !== "string" || !phone.trim() || phone.trim().length > 50) {
    throw new HttpsError("invalid-argument", "Telefone inválido.");
  }
}

// ============================================================================
// 1) PIX — cria o ingresso pendente + o pagamento Pix no Mercado Pago
// ============================================================================
exports.criarPagamentoPix = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN] },
  async (request) => {
    const { itemId, name, phone, email, cpf, eventId } = request.data || {};

    validateBuyerFields({ name, phone });
    if (!isValidEmail(email)) {
      throw new HttpsError("invalid-argument", "E-mail inválido.");
    }
    const cpfDigits = onlyDigits(cpf);
    if (cpfDigits.length !== 11) {
      throw new HttpsError("invalid-argument", "CPF inválido.");
    }
    if (!itemId || typeof itemId !== "string") {
      throw new HttpsError("invalid-argument", "Item inválido.");
    }

    const { item, amount, eventName, eventId: resolvedEventId } = await lookupItemAndEvent(itemId, eventId);

    const ticketId = genTicketId();
    const ticketRef = db.collection("tickets").doc(ticketId);
    await ticketRef.set({
      id: ticketId,
      name: name.trim(),
      phone: phone.trim(),
      cpf: cpfDigits,
      email: email.trim(),
      eventId: resolvedEventId,
      eventName,
      itemTitle: item.title,
      amount,
      paymentMethod: "pix",
      used: false,
      status: "pending",
      paymentStatus: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const client = getMpClient();
    const payment = new Payment(client);

    let mpResponse;
    try {
      mpResponse = await payment.create({
        body: {
          transaction_amount: amount,
          description: item.title,
          payment_method_id: "pix",
          external_reference: ticketId,
          payer: {
            email: email.trim(),
            first_name: name.trim().split(" ")[0],
            last_name: name.trim().split(" ").slice(1).join(" ") || name.trim(),
            identification: { type: "CPF", number: cpfDigits },
          },
        },
        requestOptions: { idempotencyKey: ticketId },
      });
    } catch (e) {
      logger.error("Erro ao criar pagamento Pix", e);
      await ticketRef.update({ status: "rejected", paymentStatus: "error" });
      throw new HttpsError("internal", "Não foi possível gerar o Pix. Tente novamente.");
    }

    const txData = mpResponse?.point_of_interaction?.transaction_data;
    if (!txData?.qr_code_base64 || !txData?.qr_code) {
      logger.error("Resposta do Mercado Pago sem QR Code", mpResponse);
      await ticketRef.update({ status: "rejected", paymentStatus: "error" });
      throw new HttpsError("internal", "Não foi possível gerar o QR Code do Pix.");
    }

    await ticketRef.update({ paymentId: String(mpResponse.id) });

    return {
      ticketId,
      paymentId: mpResponse.id,
      qrCodeBase64: txData.qr_code_base64,
      qrCode: txData.qr_code,
    };
  }
);

// ============================================================================
// 2) CARTÃO — cria o ingresso pendente + processa o pagamento com cartão
// ============================================================================
exports.criarPagamentoCartao = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN, ...EMAIL_SECRETS] },
  async (request) => {
    const {
      itemId, name, phone, eventId,
      token, payment_method_id, issuer_id, installments,
      payer,
    } = request.data || {};

    validateBuyerFields({ name, phone });
    if (!itemId || typeof itemId !== "string") {
      throw new HttpsError("invalid-argument", "Item inválido.");
    }
    if (!token || typeof token !== "string") {
      throw new HttpsError("invalid-argument", "Dados do cartão inválidos. Tente novamente.");
    }
    if (!payer?.email || !isValidEmail(payer.email)) {
      throw new HttpsError("invalid-argument", "E-mail do pagador inválido.");
    }
    const cpfDigits = onlyDigits(payer?.identification?.number);
    if (cpfDigits.length !== 11) {
      throw new HttpsError("invalid-argument", "CPF do pagador inválido.");
    }

    const { item, amount, eventName, eventId: resolvedEventId } = await lookupItemAndEvent(itemId, eventId);

    const ticketId = genTicketId();
    const ticketRef = db.collection("tickets").doc(ticketId);
    await ticketRef.set({
      id: ticketId,
      name: name.trim(),
      phone: phone.trim(),
      cpf: cpfDigits,
      email: payer.email,
      eventId: resolvedEventId,
      eventName,
      itemTitle: item.title,
      amount,
      paymentMethod: "card",
      used: false,
      status: "pending",
      paymentStatus: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const client = getMpClient();
    const payment = new Payment(client);

    let mpResponse;
    try {
      mpResponse = await payment.create({
        body: {
          transaction_amount: amount,
          token,
          description: item.title,
          installments: Number(installments) || 1,
          payment_method_id,
          issuer_id,
          external_reference: ticketId,
          payer: {
            email: payer.email,
            identification: { type: "CPF", number: cpfDigits },
          },
        },
        requestOptions: { idempotencyKey: ticketId },
      });
    } catch (e) {
      logger.error("Erro ao criar pagamento com cartão", e);
      await ticketRef.update({ status: "rejected", paymentStatus: "error" });
      throw new HttpsError("internal", "Não foi possível processar o pagamento.");
    }

    const status = mpResponse.status; // approved | in_process | rejected | ...
    const ticketDataAtual = (await ticketRef.get()).data();
    const novoStatus = await finalizarStatusIngresso(
      ticketRef, ticketDataAtual, status, mpResponse.status_detail, mpResponse.id
    );
    // "in_process" / "pending": mantém o ingresso como "pending" até o
    // webhook ou a checagem ativa confirmarem.

    return {
      ticketId,
      status: novoStatus,
      statusDetail: mpResponse.status_detail || null,
    };
  }
);

// ============================================================================
// 3) CONSULTAR STATUS — usado pelo site para saber se o Pix já foi aprovado,
//    sem precisar de leitura pública na coleção "tickets".
// ============================================================================
exports.consultarStatusIngresso = onCall(
  { region: REGION, secrets: [MP_ACCESS_TOKEN, ...EMAIL_SECRETS] },
  async (request) => {
    const { ticketId } = request.data || {};
    if (!ticketId || typeof ticketId !== "string") {
      throw new HttpsError("invalid-argument", "ticketId inválido.");
    }
    const ticketRef = db.collection("tickets").doc(ticketId);
    const snap = await ticketRef.get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "Ingresso não encontrado.");
    }
    let data = snap.data();

    // Enquanto o ingresso estiver pendente e já tivermos um paymentId,
    // consultamos a API do Mercado Pago diretamente — é isso que aprova o
    // Pix automaticamente, mesmo se o webhook não estiver configurado.
    if (data.status === "pending" && data.paymentId) {
      try {
        const client = getMpClient();
        const payment = new Payment(client);
        const mpPayment = await payment.get({ id: data.paymentId });
        await finalizarStatusIngresso(
          ticketRef, data, mpPayment.status, mpPayment.status_detail, mpPayment.id
        );
        data = (await ticketRef.get()).data();
      } catch (e) {
        logger.error(`Erro ao consultar pagamento ${data.paymentId} do ingresso ${ticketId}`, e);
        // Se a consulta falhar, devolve o status que já estava salvo.
      }
    }

    // Só devolve o status — nunca nome/telefone/CPF, mesmo essa função sendo
    // pública, para não vazar dados pessoais do comprador.
    return { status: data.status, used: !!data.used };
  }
);

// ============================================================================
// 4) WEBHOOK — o Mercado Pago chama essa URL quando o status de um pagamento
//    muda (essencial para o Pix, que é confirmado de forma assíncrona).
// ============================================================================
exports.mercadoPagoWebhook = onRequest(
  { region: REGION, secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, ...EMAIL_SECRETS] },
  async (req, res) => {
    try {
      const paymentId = req.query["data.id"] || req.body?.data?.id;
      const topic = req.query["type"] || req.body?.type;

      if (topic !== "payment" || !paymentId) {
        // Outros tipos de evento (ex.: "merchant_order") são ignorados.
        res.status(200).send("ok");
        return;
      }

      // ---- validação da assinatura (x-signature) ----
      const signatureHeader = req.get("x-signature") || "";
      const requestId = req.get("x-request-id") || "";
      const parts = Object.fromEntries(
        signatureHeader.split(",").map((p) => p.trim().split("=").map((s) => s.trim()))
      );
      const ts = parts.ts;
      const hash = parts.v1;

      if (!ts || !hash) {
        logger.warn("Webhook sem assinatura válida — ignorado.");
        res.status(401).send("assinatura ausente");
        return;
      }

      const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
      const expectedHash = crypto
        .createHmac("sha256", MP_WEBHOOK_SECRET.value())
        .update(manifest)
        .digest("hex");

      if (expectedHash !== hash) {
        logger.warn("Webhook com assinatura inválida — possível tentativa de fraude.");
        res.status(401).send("assinatura inválida");
        return;
      }

      // ---- busca o pagamento real na API (nunca confia no corpo recebido) ----
      const client = getMpClient();
      const payment = new Payment(client);
      const mpPayment = await payment.get({ id: paymentId });

      const ticketId = mpPayment.external_reference;
      if (!ticketId) {
        res.status(200).send("sem referência");
        return;
      }

      const ticketRef = db.collection("tickets").doc(ticketId);
      const ticketSnap = await ticketRef.get();
      if (!ticketSnap.exists) {
        res.status(200).send("ingresso não encontrado");
        return;
      }

      await finalizarStatusIngresso(
        ticketRef, ticketSnap.data(), mpPayment.status, mpPayment.status_detail, mpPayment.id
      );

      res.status(200).send("ok");
    } catch (e) {
      logger.error("Erro no webhook do Mercado Pago", e);
      res.status(500).send("erro interno");
    }
  }
);
