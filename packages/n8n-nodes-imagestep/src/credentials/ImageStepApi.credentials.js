"use strict";

/**
 * One API key from the ImageStep console (Settings → API keys). Sent as `Authorization: ApiKey …`
 * on every request. The credential test reads the key's own usage, a path only a valid key can: it used to list the op
 * catalogue, which is public, so a wrong or revoked key tested green (#569).
 */
class ImageStepApi {
  constructor() {
    this.name = "imageStepApi";
    this.displayName = "ImageStep API";
    this.documentationUrl = "https://imagestep.dev/docs/n8n";
    this.icon = "file:../nodes/ImageStep/imagestep.svg";
    this.properties = [
      {
        displayName: "API Key",
        name: "apiKey",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: "An ImageStep API key (console → Settings → API keys)"
      },
      {
        displayName: "Base URL",
        name: "baseUrl",
        type: "string",
        default: "https://api.imagestep.dev",
        description: "Change only for a self-hosted or staging ImageStep"
      }
    ];
    this.authenticate = {
      type: "generic",
      properties: {
        headers: {
          Authorization: "=ApiKey {{$credentials.apiKey}}"
        }
      }
    };
    this.test = {
      request: {
        baseURL: "={{$credentials.baseUrl}}",
        url: "/api/v1/usage"
      }
    };
  }
}

module.exports = { ImageStepApi };
