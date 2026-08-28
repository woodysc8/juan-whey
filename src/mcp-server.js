#!/usr/bin/env node

// Dedicated local stdio entry point. The existing server owns all schemas and
// registrations; this launcher intentionally contains no travel business logic.
import "./server.js";
