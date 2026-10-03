"use strict";

// n8n loads the nodes and credentials from the `n8n` manifest in package.json, not from here.
// This entry exists for tooling that requires the package directly (tests, scripts).
module.exports = {
  ImageStep: require("./dist/nodes/ImageStep/ImageStep.node").ImageStep,
  ImageStepTrigger: require("./dist/nodes/ImageStepTrigger/ImageStepTrigger.node").ImageStepTrigger,
  ImageStepApi: require("./dist/credentials/ImageStepApi.credentials").ImageStepApi
};
