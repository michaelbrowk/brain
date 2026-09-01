"use client";

import { useId, useState } from "react";
import type {
  CollectionDefinition,
  CollectionProperty,
  CollectionPropertyValue,
  CollectionRow,
  CollectionView as CollectionViewModel,
} from "@/lib/collections/model";
import type { TreeNode } from "@/lib/store/types";

type CollectionRowNode = TreeNode & { collectionRow: CollectionRow };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function normalizeNotionId(value: string) {
  return value.replaceAll("-", "").toLowerCase();
}

function collectionRows(
  node: TreeNode,
  definition: CollectionDefinition,
): CollectionRowNode[] {
  return node.children.filter(
    (child): child is CollectionRowNode =>
      !!child.collectionRow &&
      child.collectionRow.databaseId === definition.databaseId,
  );
}

/** Preserve the source view order, then append valid rows the source view did
 * not list. The latter matters for stale Notion views and partially resumed
 * imports: data remains reachable instead of disappearing from the UI. */
export function orderCollectionRows(
  node: TreeNode,
  definition: CollectionDefinition,
  view: CollectionViewModel,
): CollectionRowNode[] {
  const rows = collectionRows(node, definition);
  const byNotionId = new Map<string, CollectionRowNode>();
  for (const row of rows) {
    if (!row.notionId) continue;
    const notionId = normalizeNotionId(row.notionId);
    if (!byNotionId.has(notionId)) byNotionId.set(notionId, row);
  }

  const ordered: CollectionRowNode[] = [];
  const seen = new Set<string>();
  for (const notionId of view.rowNotionIds) {
    const row = byNotionId.get(normalizeNotionId(notionId));
    if (!row || seen.has(row.id)) continue;
    ordered.push(row);
    seen.add(row.id);
  }
  // A filtered Notion view intentionally omits rows. Only all-row views may
  // append valid imported rows that are absent from a stale source order.
  if (view.filter && view.filter.kind !== "all") return ordered;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    ordered.push(row);
    seen.add(row.id);
  }
  return ordered;
}

function propertiesForView(
  definition: CollectionDefinition,
  view: CollectionViewModel,
) {
  const ordered = [...definition.properties].sort(
    (left, right) => left.position - right.position,
  );
  const visible =
    view.visiblePropertyIds === undefined
      ? null
      : new Set(view.visiblePropertyIds);
  const title = ordered.find(
    (property) => property.id === definition.titlePropertyId,
  );
  const rest = ordered.filter(
    (property) =>
      property.id !== definition.titlePropertyId &&
      (visible === null || visible.has(property.id)),
  );
  return title ? [title, ...rest] : rest;
}

function formatIsoDate(value: string, includeTime: boolean, timeZone = "UTC") {
  const isDateOnly = DATE_ONLY.test(value);
  const parsed = new Date(isDateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = includeTime
    ? {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: isDateOnly ? "UTC" : timeZone,
        timeZoneName: "short",
      }
    : {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: isDateOnly ? "UTC" : timeZone,
      };
  try {
    return new Intl.DateTimeFormat("en-US", options).format(parsed);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "UTC",
    }).format(parsed);
  }
}

function EmptyValue() {
  return <span className="text-ink-3">Empty</span>;
}

function NeutralOption({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-full rounded-full bg-fill-active px-2 py-0.5 text-[12px] leading-snug text-ink-2">
      <span className="truncate">{name}</span>
    </span>
  );
}

function PropertyValue({
  property,
  value,
}: {
  property: CollectionProperty;
  value: CollectionPropertyValue | undefined;
}) {
  if (!value || value.type !== property.type) return <EmptyValue />;

  switch (value.type) {
    case "title":
      return value.value ? <>{value.value}</> : <EmptyValue />;
    case "date": {
      if (!value.value) return <EmptyValue />;
      const hasTime = !DATE_ONLY.test(value.value.start);
      const start = formatIsoDate(
        value.value.start,
        hasTime,
        value.value.timeZone,
      );
      if (!value.value.end) return <>{start}</>;
      const end = formatIsoDate(
        value.value.end,
        !DATE_ONLY.test(value.value.end),
        value.value.timeZone,
      );
      return <>{start} to {end}</>;
    }
    case "select":
      return value.value ? <NeutralOption name={value.value.name} /> : <EmptyValue />;
    case "multi_select":
      return value.value.length ? (
        <span className="flex max-w-full flex-wrap gap-1">
          {value.value.map((option) => (
            <NeutralOption key={option.id} name={option.name} />
          ))}
        </span>
      ) : (
        <EmptyValue />
      );
    case "people":
      return value.value.length ? (
        <>{value.value.map((person) => person.name || "Person").join(", ")}</>
      ) : (
        <EmptyValue />
      );
    case "verification": {
      if (!value.value) return <EmptyValue />;
      const label =
        value.value.state === "verified"
          ? "Verified"
          : value.value.state === "expired"
            ? "Expired"
            : "Unverified";
      const verifier = value.value.verifiedBy?.name;
      return <>{verifier ? `${label} by ${verifier}` : label}</>;
    }
    case "last_edited_time":
      return value.value ? (
        <>{formatIsoDate(value.value, true)}</>
      ) : (
        <EmptyValue />
      );
  }
}

function rowTitle(
  row: CollectionRowNode,
  definition: CollectionDefinition,
) {
  const sourceTitle = row.collectionRow.values[definition.titlePropertyId];
  const sourceWasEmpty = sourceTitle?.type === "title" && sourceTitle.value === "";
  const currentTitle = row.title.trim() || "Untitled";
  return {
    title: currentTitle,
    isSourceFallback: sourceWasEmpty && currentTitle === "Untitled",
  };
}

function RowTitle({
  row,
  definition,
  onSelect,
}: {
  row: CollectionRowNode;
  definition: CollectionDefinition;
  onSelect: (id: string) => void;
}) {
  const display = rowTitle(row, definition);
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      aria-label={`Open ${display.title}`}
      className={`brain-touch-min flex max-w-full items-center gap-2 rounded-xs py-1 text-left text-[13px] font-medium hover:text-ink ${
        display.isSourceFallback ? "text-ink-3" : "text-ink"
      }`}
    >
      {row.icon ? (
        <span aria-hidden className="shrink-0 text-[14px] leading-none">
          {row.icon}
        </span>
      ) : null}
      <span
        className="truncate"
        data-empty-title={display.isSourceFallback ? "true" : undefined}
      >
        {display.title}
      </span>
    </button>
  );
}

function CollectionTable({
  definition,
  view,
  rows,
  onSelect,
}: {
  definition: CollectionDefinition;
  view: CollectionViewModel;
  rows: CollectionRowNode[];
  onSelect: (id: string) => void;
}) {
  const properties = propertiesForView(definition, view);
  if (!rows.length) {
    return <p className="py-8 text-center text-[13px] text-ink-3">Nothing here yet.</p>;
  }

  return (
    <div
      role="region"
      aria-label={`${view.name || "Collection"} rows`}
      tabIndex={0}
      className="overflow-x-auto rounded-sm border border-line"
    >
      <table className="w-full min-w-[680px] border-collapse text-left text-[13px]">
        <caption className="sr-only">{view.name || "Collection"} rows</caption>
        <thead>
          <tr>
            {properties.map((property, index) => (
              <th
                key={property.id}
                scope="col"
                className={`border-b border-line px-3 py-2 text-[12px] font-medium text-ink-3 ${
                  index === 0
                    ? "sticky left-0 z-[2] min-w-[220px] bg-paper"
                    : "min-w-[150px]"
                }`}
              >
                {property.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="group">
              {properties.map((property, index) => (
                <td
                  key={property.id}
                  className={`border-b border-line px-3 py-2 align-top text-ink-2 group-last:border-b-0 group-hover:bg-fill-hover ${
                    index === 0
                      ? "sticky left-0 z-[1] bg-paper group-hover:bg-fill-hover"
                      : ""
                  }`}
                >
                  {property.id === definition.titlePropertyId ? (
                    <RowTitle
                      row={row}
                      definition={definition}
                      onSelect={onSelect}
                    />
                  ) : (
                    <PropertyValue
                      property={property}
                      value={row.collectionRow.values[property.id]}
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type BoardGroup = {
  id: string;
  name: string;
  rows: CollectionRowNode[];
};

function boardGroups(
  definition: CollectionDefinition,
  view: CollectionViewModel,
  rows: CollectionRowNode[],
): BoardGroup[] {
  const groupProperty = definition.properties.find(
    (property) => property.id === view.groupBy?.propertyId,
  );
  if (!groupProperty || groupProperty.type !== "select") {
    return [{ id: "all", name: "Rows", rows }];
  }

  const options = new Map(
    groupProperty.options.map((option) => [option.id, option]),
  );
  const orderedIds = [
    ...(view.groupBy?.manualOptionIds ?? []),
    ...groupProperty.options.map((option) => option.id),
  ].filter((id, index, values) => values.indexOf(id) === index);

  const grouped = new Map<string, CollectionRowNode[]>();
  const ungrouped: CollectionRowNode[] = [];
  for (const row of rows) {
    const value = row.collectionRow.values[groupProperty.id];
    if (value?.type !== "select" || !value.value) {
      ungrouped.push(row);
      continue;
    }
    if (!options.has(value.value.id)) options.set(value.value.id, value.value);
    const current = grouped.get(value.value.id) ?? [];
    current.push(row);
    grouped.set(value.value.id, current);
  }

  for (const optionId of grouped.keys()) {
    if (!orderedIds.includes(optionId)) orderedIds.push(optionId);
  }
  const groups = orderedIds
    .map((optionId) => ({
      id: optionId,
      name: options.get(optionId)?.name ?? "Unknown",
      rows: grouped.get(optionId) ?? [],
    }))
    .filter((group) => !view.groupBy?.hideEmptyGroups || group.rows.length > 0);
  if (ungrouped.length) {
    groups.push({
      id: "ungrouped",
      name: `No ${groupProperty.name}`,
      rows: ungrouped,
    });
  }
  return groups;
}

function CollectionBoard({
  definition,
  view,
  rows,
  onSelect,
}: {
  definition: CollectionDefinition;
  view: CollectionViewModel;
  rows: CollectionRowNode[];
  onSelect: (id: string) => void;
}) {
  const groups = boardGroups(definition, view, rows);
  const groupIdBase = useId();
  const properties = propertiesForView(definition, view).filter(
    (property) =>
      property.id !== definition.titlePropertyId &&
      property.id !== view.groupBy?.propertyId,
  );

  if (!rows.length) {
    return <p className="py-8 text-center text-[13px] text-ink-3">Nothing here yet.</p>;
  }

  return (
    <div
      role="region"
      aria-label={`${view.name || "Collection"} board`}
      tabIndex={0}
      className="overflow-x-auto pb-2"
    >
      <div className="flex min-w-max items-start gap-3">
        {groups.map((group, groupIndex) => {
          const headingId = `${groupIdBase}-${groupIndex}`;
          return (
            <section
              key={group.id}
              aria-labelledby={headingId}
              data-collection-group={group.id}
              className="w-[min(78vw,280px)] shrink-0"
            >
              <div className="mb-2 flex items-center gap-2 px-1">
                <h3
                  id={headingId}
                  className="min-w-0 truncate text-[13px] font-medium text-ink"
                >
                  {group.name}
                </h3>
                <span className="text-[12px] tabular-nums text-ink-3">
                  {group.rows.length}
                </span>
              </div>
              <div className="space-y-2">
                {group.rows.map((row) => {
                  const display = rowTitle(row, definition);
                  return (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => onSelect(row.id)}
                      aria-label={`Open ${display.title}`}
                      className="block min-h-11 w-full rounded-md border border-line bg-paper p-3 text-left transition-colors hover:bg-fill-hover"
                    >
                      <span
                        className={`flex min-w-0 items-center gap-2 text-[13px] font-medium ${
                          display.isSourceFallback ? "text-ink-3" : "text-ink"
                        }`}
                      >
                        {row.icon ? (
                          <span aria-hidden className="shrink-0 text-[14px] leading-none">
                            {row.icon}
                          </span>
                        ) : null}
                        <span
                          className="truncate"
                          data-empty-title={display.isSourceFallback ? "true" : undefined}
                        >
                          {display.title}
                        </span>
                      </span>
                      {properties.length ? (
                        <span className="mt-2 block space-y-1.5">
                          {properties.map((property) => (
                            <span
                              key={property.id}
                              className="flex items-start justify-between gap-3 text-[12px] leading-snug"
                            >
                              <span className="shrink-0 text-ink-3">
                                {property.name}
                              </span>
                              <span className="min-w-0 text-right text-ink-2">
                                <PropertyValue
                                  property={property}
                                  value={row.collectionRow.values[property.id]}
                                />
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {!group.rows.length ? (
                  <p className="px-3 py-5 text-center text-[12px] text-ink-3">
                    Empty
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Read-only source properties for a collection row page. The page title and
 * body stay ordinary Brain fields and remain editable. */
export function CollectionRowProperties({
  definition,
  row,
}: {
  definition: CollectionDefinition;
  row: CollectionRow;
}) {
  const properties = [...definition.properties]
    .sort((left, right) => left.position - right.position)
    .filter((property) => property.id !== definition.titlePropertyId);
  if (!properties.length) return null;

  return (
    <dl
      aria-label="Collection properties"
      className="brain-hscroll mt-2 flex max-w-full gap-4 overflow-x-auto pb-1 text-[12px]"
    >
      {properties.map((property) => (
        <div key={property.id} className="flex min-w-max items-baseline gap-1.5">
          <dt className="text-ink-3">{property.name}</dt>
          <dd className="text-ink-2">
            <PropertyValue property={property} value={row.values[property.id]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** First-class, read-only rendering for source-backed Notion collections.
 * Table and board are native surfaces; list/timeline views intentionally use
 * the same dependable table renderer in this narrow first release. */
export function CollectionView({
  node,
  onSelect,
}: {
  node: TreeNode;
  onSelect: (id: string) => void;
}) {
  const definition = node.collection;
  const selectId = useId();
  const [selection, setSelection] = useState<{
    databaseId: string;
    viewId: string;
  } | null>(null);

  if (!definition) return null;
  const requestedViewId =
    selection?.databaseId === definition.databaseId
      ? selection.viewId
      : definition.initialViewId;
  const view =
    definition.views.find((candidate) => candidate.id === requestedViewId) ??
    definition.views[0];
  const rows = orderCollectionRows(node, definition, view);

  return (
    <section aria-label="Collection" className="min-w-0">
      {definition.views.length > 1 ? (
        <div className="mb-3 flex justify-end">
          <label htmlFor={selectId} className="sr-only">
            Collection view
          </label>
          <select
            id={selectId}
            value={view.id}
            onChange={(event) =>
              setSelection({
                databaseId: definition.databaseId,
                viewId: event.currentTarget.value,
              })
            }
            className="brain-touch-min h-7 max-w-[220px] rounded-sm border border-line bg-paper px-2 text-[12px] text-ink-2 outline-none hover:bg-fill-hover hover:text-ink max-md:text-[16px]"
          >
            {definition.views.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name ||
                  candidate.type[0].toUpperCase() + candidate.type.slice(1)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {view.type === "board" ? (
        <CollectionBoard
          definition={definition}
          view={view}
          rows={rows}
          onSelect={onSelect}
        />
      ) : (
        <CollectionTable
          definition={definition}
          view={view}
          rows={rows}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}
