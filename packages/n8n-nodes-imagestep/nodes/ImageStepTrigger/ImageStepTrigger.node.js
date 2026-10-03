"use strict";

const { NodeConnectionTypes } = require("n8n-workflow");
const api = require("../../lib/api");
const { verifySignature } = require("../../lib/signature");

const MAIN = (NodeConnectionTypes && NodeConnectionTypes.Main) || "main";

const EVENTS = [
  { name: "Job Completed", value: "job.completed", description: "Every item settled, none failed" },
  { name: "Job Failed", value: "job.failed", description: "Every item settled, at least one failed (or the job was cancelled)" },
  { name: "Job Item Completed", value: "job.item.completed", description: "One item finished — opt in; a 500-item job sends 500 of these" },
  { name: "Job Item Failed", value: "job.item.failed", description: "One item failed — opt in" }
];

/**
 * ImageStep Trigger — a webhook endpoint registered on activation (`POST /api/v1/webhook-endpoints`),
 * verified per delivery (HMAC-SHA256 over `"<t>.<raw body>"`, docs/api-contract.md §6) and
 * removed on deactivation. Emits one item per event: `{ id, type, createdAt, data }`.
 */
class ImageStepTrigger {
  constructor() {
    this.description = {
      displayName: "ImageStep Trigger",
      name: "imageStepTrigger",
      icon: "file:imagestep.svg",
      group: ["trigger"],
      version: 1,
      subtitle: '={{ $parameter["events"].join(", ") }}',
      description: "Starts the workflow when an ImageStep job finishes (signed webhook — stop polling)",
      defaults: { name: "ImageStep Trigger" },
      inputs: [],
      outputs: [MAIN],
      credentials: [{ name: api.CREDENTIAL, required: true }],
      webhooks: [{ name: "default", httpMethod: "POST", responseMode: "onReceived", path: "webhook" }],
      properties: [
        {
          displayName: "Events",
          name: "events",
          type: "multiOptions",
          options: EVENTS,
          default: ["job.completed", "job.failed"],
          required: true,
          description: "Which events to subscribe to. Per-item events are opt-in for a reason: they arrive once per item."
        },
        {
          displayName: "Signature Tolerance (Seconds)",
          name: "tolerance",
          type: "number",
          default: 300,
          typeOptions: { minValue: 30, maxValue: 3600 },
          description: "Reject deliveries whose signed timestamp is older than this — the replay guard"
        }
      ]
    };

    this.webhookMethods = {
      default: {
        /** The stored endpoint still exists on the account and points at this URL. */
        async checkExists() {
          const staticData = this.getWorkflowStaticData("node");
          if (!staticData.webhookId) return false;
          try {
            const endpoint = await api.getWebhookEndpoint(this, staticData.webhookId);
            if (endpoint && endpoint.url === this.getNodeWebhookUrl("default")) return true;
          } catch (error) {
            if (String(error.httpCode) !== "404") throw error;
          }
          delete staticData.webhookId;
          delete staticData.webhookSecret;
          return false;
        },
        /** Register; the secret is returned once, so it is stored right here. */
        async create() {
          const staticData = this.getWorkflowStaticData("node");
          const endpoint = await api.createWebhookEndpoint(this, {
            url: this.getNodeWebhookUrl("default"),
            events: this.getNodeParameter("events"),
            description: `n8n: ${this.getWorkflow().name || "workflow"} / ${this.getNode().name}`
          });
          staticData.webhookId = endpoint.id;
          staticData.webhookSecret = endpoint.secret;
          return true;
        },
        async delete() {
          const staticData = this.getWorkflowStaticData("node");
          if (staticData.webhookId) {
            try {
              await api.deleteWebhookEndpoint(this, staticData.webhookId);
            } catch (error) {
              if (String(error.httpCode) !== "404") return false;
            }
          }
          delete staticData.webhookId;
          delete staticData.webhookSecret;
          return true;
        }
      }
    };
  }

  /** One delivery. Verify first, answer fast, then hand the event to the workflow. */
  async webhook() {
    const req = this.getRequestObject();
    const res = this.getResponseObject();
    const headers = this.getHeaderData() || {};
    const staticData = this.getWorkflowStaticData("node");
    const secret = staticData.webhookSecret;
    const tolerance = this.getNodeParameter("tolerance", 300);

    // The contract signs the raw bytes. n8n keeps them on req.rawBody; when a proxy or an older
    // n8n drops that, the parsed body is re-serialised — that is best effort and the README says so.
    const rawBody = req && req.rawBody ? req.rawBody : JSON.stringify(this.getBodyData());
    const signature = headers["imagestep-signature"];
    if (!secret || !verifySignature(rawBody, signature, secret, { toleranceSeconds: tolerance })) {
      res.status(401).json({ error: "invalid signature" });
      return { noWebhookResponse: true };
    }

    const event = this.getBodyData() || {};
    return {
      workflowData: [
        this.helpers.returnJsonArray([
          {
            id: event.id || headers["imagestep-event-id"],
            type: event.type || headers["imagestep-event-type"],
            createdAt: event.createdAt,
            attempt: Number(headers["imagestep-attempt"] || 1),
            data: event.data || {}
          }
        ])
      ]
    };
  }
}

module.exports = { ImageStepTrigger };
