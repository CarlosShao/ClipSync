# Collection Hierarchy Feature — Specification

## Problem Statement

The Favorites sidebar collection bar is a flat horizontal strip of tabs. As users accumulate more collections, the tabs wrap into multiple rows, consuming vertical space and making it increasingly difficult to locate a specific collection. The current flat structure offers no logical grouping — a user who categorizes work items, AI research, and personal snippets all face the same wall of undifferentiated tabs. The feature needs tree-structured collections so users can nest, group, and navigate their collections hierarchically, matching the familiar browser-bookmark model.

## Solution

Transform the flat collection list into a hierarchical tree with unlimited nesting depth. Collections become folder nodes that can contain both child collections and clipboard items. The sidebar presents a collapsible tree with breadcrumb navigation for the active node. Drag-and-drop nesting, right-click context menus, and hover flyout previews mirror the interaction model users already know from Chrome/Edge bookmarks. The backend adopts PostgreSQL `ltree` for efficient path-based tree queries. Existing flat collections migrate to root-level nodes with no data loss.

## User Stories

1. As a user, I want collections arranged in a tree structure, so that related collections are grouped under shared parent folders instead of scattered across a flat tab bar.

2. As a user, I want to create a sub-collection inside an existing collection, so that I can organize collections into categories (e.g., `Models → AI → mimo`).

3. As a user, I want to right-click any collection to create a child folder directly beneath it, so that I can nest without leaving the sidebar context.

4. As a user, I want to drag one collection onto another to nest it, so that I can reorganize my hierarchy visually.

5. As a user, I want the sidebar to show tree indentation with expand/collapse triangles, so that I can see the full hierarchy at a glance.

6. As a user, I want to collapse and expand parent collections on demand, so that I can focus on a specific branch of the tree.

7. As a user, I want breadcrumb navigation above the collection tree, so that I always know my current position and can jump to any ancestor.

8. As a user, I want to hover over a parent collection and see a flyout preview of its direct children, so that I can browse sub-collections without clicking into them.

9. As a user, I want to click a collection and see only the items directly inside that collection (not items from descendants), so that each folder shows its own scope.

10. As a user, I want to move an item into a collection and have it removed from any previous collection, so that each item has a single, unambiguous home.

11. As a user, I want to delete a collection that has sub-collections and have everything inside it removed entirely, so that I can clean up branches without orphaned data.

12. As a user, I want existing flat collections to remain accessible after the update without any manual reorganization, so that my data is never lost.

13. As a user, I want the visual design of the collection bar to remain compact and not expand significantly in width, so that the sidebar stays usable alongside the content area.

14. As a user, I want each collection tab/node to show an icon, name, and item count, so that I can quickly identify collections at a glance.

15. As a user, I want a "New Collection" / "New Folder" option when right-clicking on empty space in the sidebar, so that I can create root-level collections from any context.

16. As a user, I want drag-and-drop to highlight the target collection when hovering over it, so that I know the drop will succeed before releasing.

17. As a user, I want to rename a collection inline by double-clicking or via a context menu, so that I can correct names without opening a separate dialog.

18. As a user, I want to reorder sibling collections by dragging, so that I can sort them by priority or frequency of use.

19. As a developer, I want the hierarchy stored as an `ltree` path in PostgreSQL, so that subtree queries, sorting, and path operations are efficient at any depth.

20. As a developer, I want the backend to reject circular references (a collection cannot be nested inside its own descendant), so that the tree remains acyclic.

## Implementation Decisions

### Backend

- **Schema change**: Add a `path ltree` column to `favorite_collections`. Existing rows default to their `id` as root path (e.g., `path = id::text::ltree`), making every existing collection a root node with no parent.
- **Index**: Create a GIST index on `favorite_collections(path)` for fast subtree queries (`path <@ '/root'`).
- **Migration**: A single SQL migration that adds the `path` column, populates it for existing rows, and creates the GIST index. No data transformation beyond path initialization.
- **Create child collection**: The `POST /api/favorites/collections` endpoint accepts an optional `parentId`. When provided, the server computes the child's `path` as `parent.path || '.' || new_id`. If the parent path is the root path (only one element), the child path has two elements.
- **Move collection**: A new `PUT /api/favorites/collections/:id/move` endpoint accepts `parentId`. The server validates the target is not a descendant of the moved node (circular reference check), then updates the `path`. All descendants' paths are rewritten using `ltree` subpath operations (`nlevel`, `subpath`).
- **Cascade delete**: `DELETE /api/favorites/collections/:id` deletes the collection and all descendants. PostgreSQL CASCADE on the FK handles items; a server-side recursive query or `ltree` query handles descendant collections.
- **List collections**: `GET /api/favorites/collections` returns all collections with their `path`. The frontend builds the tree from the flat list using `ltree` hierarchical functions or by sorting by path.
- **Item uniqueness**: The existing composite PK on `favorite_collection_items(collection_id, item_id)` is extended — an item can still only appear once per collection, but across the entire tree, an item belongs to exactly one collection. A unique constraint on `item_id` in `favorite_collection_items` enforces single ownership across all collections.
- **API response shape**: Collection objects include `id`, `name`, `icon`, `path`, `sort_order`, `item_count`, `created_at`. The `path` field is returned to the frontend so it can compute depth and indentation.
- **Rate limiting**: All new endpoints (move) use the existing `apiLimiter` middleware.

### Frontend

- **Data model**: Replace the flat `collections` array with a tree structure built from the flat `path` field. Each node has `id`, `name`, `icon`, `path`, `depth`, `children[]`, `item_count`, `expanded` state.
- **Sidebar layout**: Replace the horizontal tab bar with a vertical tree sidebar. The tree sits in the left panel of the Favorites view. Breadcrumbs appear above the tree. The content area below shows items for the selected collection.
- **Expand/collapse**: Each parent node has a chevron icon (lucide `ChevronRight` / `ChevronDown`). Clicking the chevron toggles the `expanded` state. Clicking the node name selects it and loads its items.
- **Breadcrumb**: A horizontal breadcrumb strip above the tree: `root > models > AI`. Each segment is clickable. "root" links to show all collections as a flat list.
- **Hover flyout**: Hovering over a parent node shows a flyout panel listing its direct children (collections only, not items). Clicking a child in the flyout navigates into it. The flyout closes on mouse leave after a short delay.
- **Context menu**: Right-clicking a collection node shows: Rename, New Sub-Collection, Move to (nested selector), Delete. Right-clicking empty space shows: New Root Collection. The context menu is a reusable component positioned at the click coordinates.
- **Drag-and-drop nesting**: A collection node can be dragged onto another collection. The target highlights during drag-over. Dropping on a parent moves the dragged collection inside it. Dropping on empty space cancels the drag. Circular reference drags are blocked (no visual feedback, no API call).
- **Drag-and-drop reorder**: Sibling collections can be reordered by dragging within the same level. Visual feedback: a horizontal insertion indicator between siblings.
- **Create sub-collection**: Right-click → "New Sub-Collection" creates an inline editable name field beneath the parent node. Enter confirms, Escape cancels. Calls `POST /api/favorites/collections` with `parentId`.
- **Inline rename**: Double-clicking a collection name turns it into an input field. Enter confirms, Escape reverts. Calls `PUT /api/favorites/collections/:id` with `name`.
- **Item tree navigation**: When a collection is selected, its direct items appear in the content area (same grid/list as today). A "..." sub-collections row appears at the top of the content area showing child collections as quick-access buttons.

### Shared / Cross-cutting

- **Composable**: A new `useCollections` composable manages the tree state (flat list from API → tree transform, expand/collapse, selected node, breadcrumb stack). It is consumed by FavoritesView and any future view that needs collections.
- **Drag-and-drop library**: Use native HTML5 drag-and-drop API (no external library). The tree nodes use `draggable`, `@dragstart`, `@dragover`, `@drop`, `@dragenter`, `@dragleave` events. This keeps the dependency footprint minimal.
- **Tree CSS**: Tree indentation via `padding-left` proportional to `depth`. Chevron rotation via CSS transform. Flyout panel uses absolute positioning within the tree node's bounding rect, with overflow clipping and z-index.
- **Teleport**: Context menu and flyout panels use `<Teleport to="body">` to escape parent stacking contexts.

## Out of Scope

- Collection sharing / collaboration between users
- Collection color themes or custom folder colors beyond the existing icon system
- Import/export of collection hierarchies
- Collection description or notes field
- Unlimited depth performance testing beyond 50 levels (ltree supports up to 65535 levels)
- Undo/redo for move, delete, or rename operations
- Search within collection tree (global search remains flat)
- Collection-level permissions or access control

## Further Notes

- The `ltree` extension is included in standard PostgreSQL distributions but may need explicit activation (`CREATE EXTENSION IF NOT EXISTS ltree;`) in the database initialization script.
- The `path` column stores dot-separated labels (e.g., `.root.models.ai.mimo`). The leading dot convention keeps paths rooted and avoids empty labels.
- Item count for each collection node is computed server-side via a LEFT JOIN with `favorite_collection_items`, filtered by the collection's exact ID (not descendants) to support the "direct items only" browsing behavior.
- The existing `COLLECTION_ICON_MAP` and lucide icon system are preserved — child collections use the same icon picker as root collections.
- FavoritesView.vue is the primary file modified. ClipboardView.vue's collection-related popover may need minor adjustments to pass `parentId` when creating from the clipboard context.
- No changes to `favorite_tags` or the tag color system are required — tags and collections remain orthogonal systems.
