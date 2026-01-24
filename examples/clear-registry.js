#!/usr/bin/env node

// Clear Registry - Delete all data from the registry
import { registry } from '../src/runtime/index.js';

async function clearRegistry() {
  console.log("⚠️  WARNING: Clearing all registry data...");
  console.log("");

  // Show stats before clearing
  const statsBefore = await registry.stats();
  console.log("   Current entries:", statsBefore.count);
  console.log("   Storage:", statsBefore.file);
  console.log("");

  // Clear the registry
  await registry.clear();

  console.log("✅ Registry cleared successfully!");
  console.log("");

  // Show stats after clearing
  const statsAfter = await registry.stats();
  console.log("   Entries remaining:", statsAfter.count);
  console.log("");

  process.exit(0);
}

clearRegistry().catch((error) => {
  console.error("❌ Error clearing registry:", error.message);
  process.exit(1);
});
