// MB-MEM-001 persistent gameplay memory: public module surface.
export { MemoryBook, isProtected, isTrusted } from './book.ts';
export { instructionWordSet, labelKey, ownerGrounding } from './labels.ts';
export { MemoryRefRegistry } from './refs.ts';
export { MEMORY_PLANNER_INSTRUCTIONS, renderMemoryView } from './render.ts';
export { inspectMemory, renderMemoryReport, type MemoryReport } from './report.ts';
export { MEMORY_VIEW_RULES, buildView, refEligible, type ViewRequest } from './retrieval.ts';
export { MemoryService, memoryRoot, type MemoryServiceOptions, type MemoryWriteOutcome } from './service.ts';
export { MEMORY_MIGRATIONS, MemoryFileStore, bodyChecksum, scopeDirectory, type MemoryLoad, type MemoryMigration } from './store.ts';
export { installedMemoryWorld, type ActionEvidence, type DeathContext, type MemoryWorld } from './world.ts';
