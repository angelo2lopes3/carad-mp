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
 *   - consultarStatusIngresso: permite o site perguntar "esse ingresso já
 *                              foi aprovado?" sem precisar de acesso de
 *                              leitura direto à coleção "tickets" (que é
 *                              bloqueada para o público no firestore.rules).
 *   - mercadoPagoWebhook     : recebe a confirmação assíncrona do Mercado
 *                              Pago (principalmente para o Pix) e aprova o
 *                              ingresso automaticamente. Valida a assinatura
 *                              (x-signature) para garantir que a notificação
 *                              realmente veio do Mercado Pago — sem isso,
 *                              qualquer pessoa poderia "fingir" um pagamento
 *                              aprovado só chamando essa URL.
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

admin.initializeApp();
const db = admin.firestore();

const REGION = "southamerica-east1";
const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MP_WEBHOOK_SECRET");

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
  { region: REGION, secrets: [MP_ACCESS_TOKEN] },
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
    const updates = {
      paymentId: String(mpResponse.id),
      paymentStatus: status,
      paymentStatusDetail: mpResponse.status_detail || null,
    };
    if (status === "approved") {
      updates.status = "approved";
    } else if (status === "rejected" || status === "cancelled") {
      updates.status = "rejected";
    }
    // "in_process" / "pending": mantém o ingresso como "pending" até o
    // webhook confirmar (ou o admin revisar manualmente pelo painel).
    await ticketRef.update(updates);

    return {
      ticketId,
      status,
      statusDetail: mpResponse.status_detail || null,
    };
  }
);

// ============================================================================
// 3) CONSULTAR STATUS — usado pelo site para saber se o Pix já foi aprovado,
//    sem precisar de leitura pública na coleção "tickets".
// ============================================================================
exports.consultarStatusIngresso = onCall({ region: REGION }, async (request) => {
  const { ticketId } = request.data || {};
  if (!ticketId || typeof ticketId !== "string") {
    throw new HttpsError("invalid-argument", "ticketId inválido.");
  }
  const snap = await db.collection("tickets").doc(ticketId).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Ingresso não encontrado.");
  }
  const data = snap.data();
  // Só devolve o status — nunca nome/telefone/CPF, mesmo essa função sendo
  // pública, para não vazar dados pessoais do comprador.
  return { status: data.status, used: !!data.used };
});

// ============================================================================
// 4) WEBHOOK — o Mercado Pago chama essa URL quando o status de um pagamento
//    muda (essencial para o Pix, que é confirmado de forma assíncrona).
// ============================================================================
exports.mercadoPagoWebhook = onRequest(
  { region: REGION, secrets: [MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET] },
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

      const status = mpPayment.status;
      const updates = {
        paymentId: String(mpPayment.id),
        paymentStatus: status,
        paymentStatusDetail: mpPayment.status_detail || null,
      };
      if (status === "approved") {
        updates.status = "approved";
      } else if (status === "rejected" || status === "cancelled") {
        updates.status = "rejected";
      }
      await ticketRef.update(updates);

      res.status(200).send("ok");
    } catch (e) {
      logger.error("Erro no webhook do Mercado Pago", e);
      res.status(500).send("erro interno");
    }
  }
);
