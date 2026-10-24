import catalog from "../../docs/models.json" with { type: "json" };
import type { Catalog } from "../domain/catalog/registry.ts";

export function publishedCatalog(): Catalog { return catalog as Catalog; }
