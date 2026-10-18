// Prints one of everything the CLI colours: a log line, and a result as JSON, YAML and a table (test/no-color.test.js).
import { formatOutput } from "../../src/utils/formatter.js";
import { logger } from "../../src/utils/logger.js";

logger.warn("a warning");
formatOutput({ id: "a1", count: 2 }, "json");
formatOutput({ id: "a1", count: 2 }, "yaml");
formatOutput([{ id: "a1", count: 2 }], "table");
