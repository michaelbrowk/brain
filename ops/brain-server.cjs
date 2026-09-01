"use strict";

// Keep the stable server.js entrypoint so a rollback to a legacy release still
// starts normally. New releases preserve Next's generated entrypoint beside
// this wrapper and install the shutdown capture before Next begins listening.
require("./brain-shutdown-preload.mjs");
require("./brain-next-server.js");
