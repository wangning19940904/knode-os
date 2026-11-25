import { registerCrudRecipe } from './crud-news.js';
import { registerLoongRecipe } from './loong.js';
import { registerMudabenchRecipe } from './mudabench.js';
import { registerWikiHopsRecipe } from './wiki-hops.js';
import { registerWildGraphBenchRecipe } from './wildgraphbench.js';

/** The real-document recipes of docs/design/33 §4 (built from local downloads; gold from the datasets). */
export function registerRealDocRecipes(): void {
  registerLoongRecipe();
  registerMudabenchRecipe();
  registerWikiHopsRecipe();
  registerCrudRecipe();
  registerWildGraphBenchRecipe();
}
