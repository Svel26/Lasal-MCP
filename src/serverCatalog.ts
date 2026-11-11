#!/usr/bin/env node
import { startCatalogServer } from "./servers/catalogServer.js";

await startCatalogServer("visu");
