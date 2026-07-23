/**
 * Plugin system public surface.
 *
 * Declared as explicit named re-exports (no `export *`) so that adding an
 * export to an internal module does not silently widen this subpath's API.
 */

export { PluginContext } from "./PluginContext";
export {
  InstalledPlugin,
  QueryInfo,
  StingerloomPlugin,
} from "./StingerloomPlugin";
export {
  DeleteEntry,
  InsertEntry,
  PersistEntry,
  TrackedEntry,
} from "./buffer/BufferEntry";
export {
  BufferCascadeOptions,
  BufferChangeset,
  BufferFlushResult,
  BufferPluginOptions,
  BufferPreviewEntry,
  BulkDeleteEntry,
  BulkUpdateEntry,
  ChangeTrackingPolicy,
  FlushEvent,
  FlushEventListener,
  FlushEventType,
  FlushMode,
  LockMode,
} from "./buffer/BufferPreview";
export { BufferStrategy, SnapshotStrategy } from "./buffer/BufferStrategy";
export { EntityState } from "./buffer/EntityUnitState";
export { WriteBuffer } from "./buffer/WriteBuffer";
export { bufferPlugin } from "./buffer/bufferPlugin";
export {
  FilteredMappedPipeline,
  MappedPipeline,
  RawPipeline,
  RawPipelineOptions,
  rawPipelinePlugin,
} from "./raw-pipeline/index";
