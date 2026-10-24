import type {
  BatchNodeRef,
  NodeInput,
  SceneBatchCreateNodeOptions,
  SceneBatchNodeChanges,
  SceneBatchOperation,
} from "./types.js";

/**
 * Builder for a bounded atomic retained-scene command.
 *
 * Pass the completed batch to `Client.applySceneBatch`. It is deliberately a
 * small command builder rather than a widget toolkit or virtual-DOM layer.
 */
export class SceneBatch {
  private readonly entries: SceneBatchOperation[] = [];

  /** Creates an empty batch. */
  public constructor() {}

  /** Creates a batch from explicit ordered operations. */
  public static fromOperations(operations: Iterable<SceneBatchOperation>): SceneBatch {
    const batch = new SceneBatch();
    for (const operation of operations) {
      batch.push(operation);
    }
    return batch;
  }

  /** Creates a batch-local reference to a node declared by an earlier operation. */
  public static alias(alias: string): BatchNodeRef {
    return { alias };
  }

  /** Returns a snapshot of the ordered operations. */
  public get operations(): readonly SceneBatchOperation[] {
    return [...this.entries];
  }

  /** Appends an explicit operation. */
  public push(operation: SceneBatchOperation): this {
    this.entries.push(operation);
    return this;
  }

  /** Appends a node creation and binds its batch-local alias. */
  public createNode(
    alias: string,
    node: NodeInput,
    options: SceneBatchCreateNodeOptions = {},
  ): this {
    return this.push({
      op: "create_node",
      alias,
      node,
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      ...(options.layer === undefined ? {} : { layer: options.layer }),
    });
  }

  /** Appends an atomic partial update for an existing handle or earlier alias. */
  public setNode(node: BatchNodeRef, changes: SceneBatchNodeChanges): this {
    return this.push({ op: "set_node", node, changes });
  }

  /** Appends a node removal for an existing handle or earlier alias. */
  public removeNode(node: BatchNodeRef): this {
    return this.push({ op: "remove_node", node });
  }
}
