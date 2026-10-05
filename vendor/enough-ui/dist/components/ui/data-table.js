"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { flexRender } from "@tanstack/react-table";
import { cn } from "../../lib/utils.js";
import { directionIconClass, sortIndicatorPaths } from "../../lib/direction-icons.js";
import { Checkbox } from "./checkbox.js";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./table.js";
function getCellValue(row, column) {
    if (column.accessorKey === undefined)
        return undefined;
    return row[column.accessorKey];
}
function compareValues(a, b) {
    if (a === b)
        return 0;
    if (a == null)
        return 1;
    if (b == null)
        return -1;
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    return String(a).localeCompare(String(b), undefined, {
        numeric: true,
        sensitivity: "base",
    });
}
function alignClass(align) {
    if (align === "center")
        return "text-center";
    if (align === "right")
        return "text-right";
    return "text-left";
}
function DataTable({ columns, data, getRowId, caption, emptyMessage = "No results found.", pageSize = 5, searchKey, searchPlaceholder = "Filter rows…", selectable = false, initialSort, onSelectionChange, className, ...props }) {
    const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 5;
    const [query, setQuery] = React.useState("");
    const [page, setPage] = React.useState(0);
    const [sort, setSort] = React.useState(initialSort
        ? {
            columnId: initialSort.columnId,
            direction: initialSort.direction ?? "asc",
        }
        : null);
    const [selectedIds, setSelectedIds] = React.useState(() => new Set());
    const filteredRows = React.useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery || searchKey === undefined)
            return data;
        return data.filter((row) => String(row[searchKey] ?? "")
            .toLocaleLowerCase()
            .includes(normalizedQuery));
    }, [data, query, searchKey]);
    const sortedRows = React.useMemo(() => {
        if (!sort)
            return filteredRows;
        const column = columns.find((item) => item.id === sort.columnId);
        if (column?.accessorKey === undefined)
            return filteredRows;
        return [...filteredRows].sort((a, b) => {
            const result = compareValues(getCellValue(a, column), getCellValue(b, column));
            return sort.direction === "asc" ? result : -result;
        });
    }, [columns, filteredRows, sort]);
    const pageCount = Math.max(1, Math.ceil(sortedRows.length / safePageSize));
    const activePage = Math.min(page, pageCount - 1);
    const visibleRows = sortedRows.slice(activePage * safePageSize, (activePage + 1) * safePageSize);
    const visibleIds = visibleRows.map(getRowId);
    const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
    const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    const selectAllState = allVisibleSelected
        ? true
        : selectedVisibleCount > 0
            ? "indeterminate"
            : false;
    const updateSelection = React.useCallback((nextIds) => {
        setSelectedIds(nextIds);
        onSelectionChange?.(data.filter((row) => nextIds.has(getRowId(row))));
    }, [data, getRowId, onSelectionChange]);
    const toggleSort = (columnId) => {
        setSort((current) => {
            if (current?.columnId !== columnId) {
                return { columnId, direction: "asc" };
            }
            if (current.direction === "asc") {
                return { columnId, direction: "desc" };
            }
            return null;
        });
        setPage(0);
    };
    const toggleVisibleRows = (checked) => {
        const nextIds = new Set(selectedIds);
        visibleIds.forEach((id) => {
            if (checked === true)
                nextIds.add(id);
            else
                nextIds.delete(id);
        });
        updateSelection(nextIds);
    };
    const toggleRow = (row, checked) => {
        const id = getRowId(row);
        const nextIds = new Set(selectedIds);
        if (checked === true)
            nextIds.add(id);
        else
            nextIds.delete(id);
        updateSelection(nextIds);
    };
    const startRow = sortedRows.length === 0 ? 0 : activePage * safePageSize + 1;
    const endRow = Math.min((activePage + 1) * safePageSize, sortedRows.length);
    const totalColumns = Math.max(1, columns.length + (selectable ? 1 : 0));
    return (_jsxs("div", { className: cn("w-full font-sans text-[var(--color-text-main)]", className), ...props, children: [searchKey !== undefined && (_jsxs("div", { className: "mb-3 flex flex-wrap items-center justify-between gap-3 border border-[var(--color-ink)] bg-[var(--color-card)] p-3 shadow-[var(--shadow-card)] rounded-none", children: [_jsxs("label", { className: "relative block w-full max-w-sm", children: [_jsx("span", { className: "sr-only", children: "Filter table" }), _jsx("span", { "aria-hidden": "true", className: "pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--color-text-3)]", children: "\u2315" }), _jsx("input", { type: "search", value: query, onChange: (event) => {
                                    setQuery(event.target.value);
                                    setPage(0);
                                }, placeholder: searchPlaceholder, className: "h-10 w-full rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] py-2 pl-9 pr-9 text-[13px] outline-none placeholder:text-[var(--color-text-4)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1" }), query && (_jsx("button", { type: "button", "aria-label": "Clear filter", onClick: () => {
                                    setQuery("");
                                    setPage(0);
                                }, className: "absolute right-0 top-0 flex h-10 w-10 cursor-pointer items-center justify-center rounded-none border-l border-[var(--color-ink)] bg-[var(--color-paper)] text-base hover:bg-[var(--color-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]", children: "\u00D7" }))] }), _jsxs("span", { className: "font-sans text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-3)]", children: [sortedRows.length, " ", sortedRows.length === 1 ? "record" : "records"] })] })), _jsxs("div", { className: "overflow-hidden rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-[var(--shadow-palette)]", children: [_jsx("div", { className: "w-full overflow-x-auto", children: _jsxs("table", { className: "w-full min-w-[640px] border-collapse text-[13px]", children: [caption && _jsx("caption", { className: "sr-only", children: caption }), _jsx("thead", { className: "bg-[var(--color-ink)] text-[var(--color-dark-text)]", children: _jsxs("tr", { children: [selectable && (_jsx("th", { scope: "col", className: "w-12 border-r border-[var(--color-ink-border)] px-4 py-3 text-left", children: _jsx(Checkbox, { checked: selectAllState, onCheckedChange: toggleVisibleRows, "aria-label": "Select all rows on this page", className: "border-[var(--color-dark-text-3)] bg-[var(--color-ink-2)] data-[state=checked]:border-[var(--color-dark-text)] data-[state=checked]:bg-[var(--color-dark-text)] data-[state=checked]:text-[var(--color-ink)] data-[state=indeterminate]:border-[var(--color-dark-text)] data-[state=indeterminate]:bg-[var(--color-dark-text)] data-[state=indeterminate]:text-[var(--color-ink)]" }) })), columns.map((column, index) => {
                                                const isSorted = sort?.columnId === column.id;
                                                const ariaSort = isSorted
                                                    ? sort.direction === "asc"
                                                        ? "ascending"
                                                        : "descending"
                                                    : column.sortable
                                                        ? "none"
                                                        : undefined;
                                                return (_jsx("th", { scope: "col", "aria-sort": ariaSort, className: cn("border-[var(--color-ink-border)] px-4 py-3 font-sans text-[11px] font-semibold uppercase tracking-[0.12em]", index < columns.length - 1 && "border-r", alignClass(column.align), column.headerClassName), children: column.sortable ? (_jsxs("button", { type: "button", onClick: () => toggleSort(column.id), className: cn("inline-flex w-full cursor-pointer items-center gap-2 rounded-none text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-on-ink)]", column.align === "center" && "justify-center", column.align === "right" && "justify-end"), children: [_jsx("span", { children: column.header }), _jsx("svg", { "aria-hidden": "true", focusable: "false", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", className: cn(directionIconClass, "text-[var(--color-dark-text-3)]"), children: _jsx("path", { d: sortIndicatorPaths[isSorted ? sort.direction : "none"] }) })] })) : (column.header) }, column.id));
                                            })] }) }), _jsx("tbody", { children: visibleRows.length > 0 ? (visibleRows.map((row, rowIndex) => {
                                        const rowId = getRowId(row);
                                        const isSelected = selectedIds.has(rowId);
                                        return (_jsxs("tr", { "data-state": isSelected ? "selected" : undefined, className: "border-b border-[var(--color-ink)] bg-[var(--color-surface)] transition-colors last:border-b-0 hover:bg-[var(--color-paper)] data-[state=selected]:bg-[var(--color-accent-soft)]", children: [selectable && (_jsx("td", { className: "w-12 border-r border-[var(--color-ink)] px-4 py-3", children: _jsx(Checkbox, { checked: isSelected, onCheckedChange: (checked) => toggleRow(row, checked), "aria-label": `Select row ${activePage * safePageSize + rowIndex + 1}` }) })), columns.map((column, index) => (_jsx("td", { className: cn("border-[var(--color-ink)] px-4 py-3.5 align-middle text-[var(--color-text-2)]", index < columns.length - 1 && "border-r", alignClass(column.align), column.className), children: column.cell
                                                        ? column.cell(row)
                                                        : React.isValidElement(getCellValue(row, column))
                                                            ? getCellValue(row, column)
                                                            : String(getCellValue(row, column) ?? "—") }, column.id)))] }, rowId));
                                    })) : (_jsx("tr", { children: _jsx("td", { colSpan: totalColumns, className: "h-32 px-4 text-center", children: _jsxs("div", { className: "mx-auto flex max-w-xs flex-col items-center gap-2 text-[var(--color-text-3)]", children: [_jsx("span", { "aria-hidden": "true", className: "font-sans text-2xl", children: "\u2205" }), _jsx("span", { className: "text-[13px]", children: emptyMessage })] }) }) })) })] }) }), _jsxs("div", { className: "flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-ink)] bg-[var(--color-card)] px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [selectable && (_jsxs("span", { className: "font-sans text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-3)]", children: [data.filter((row) => selectedIds.has(getRowId(row))).length, " selected"] })), _jsxs("span", { className: "text-[12px] text-[var(--color-text-3)]", children: [startRow, "\u2013", endRow, " of ", sortedRows.length] })] }), _jsxs("div", { className: "flex items-center", children: [_jsx("button", { type: "button", onClick: () => setPage(Math.max(0, activePage - 1)), disabled: activePage === 0, className: "h-8 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] px-3 font-sans text-[11px] uppercase tracking-[0.08em] hover:bg-[var(--color-paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-35", children: "Prev" }), _jsxs("span", { className: "flex h-8 min-w-20 items-center justify-center border-y border-[var(--color-ink)] bg-[var(--color-ink)] px-3 font-sans text-[11px] text-[var(--color-dark-text)]", children: [activePage + 1, " / ", pageCount] }), _jsx("button", { type: "button", onClick: () => setPage(Math.min(pageCount - 1, activePage + 1)), disabled: activePage >= pageCount - 1, className: "h-8 rounded-none border border-[var(--color-ink)] bg-[var(--color-surface)] px-3 font-sans text-[11px] uppercase tracking-[0.08em] hover:bg-[var(--color-paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-35", children: "Next" })] })] })] })] }));
}
/** Renders TanStack's current row model using EnoughUI's Table primitives. */
function TanStackDataTable({ table, caption, emptyMessage = "No results found.", className, ...props }) {
    const rows = table.getRowModel().rows;
    return (_jsx("div", { "data-slot": "data-table", className: cn("w-full", className), ...props, children: _jsxs(Table, { children: [caption && _jsx(TableCaption, { children: caption }), _jsx(TableHeader, { children: table.getHeaderGroups().map((group) => (_jsx(TableRow, { className: "hover:bg-transparent", children: group.headers.map((header) => (_jsx(TableHead, { scope: header.colSpan > 1 ? "colgroup" : "col", colSpan: header.colSpan, "aria-sort": header.colSpan === 1 && header.column.getCanSort() ? header.column.getIsSorted() === "asc" ? "ascending" : header.column.getIsSorted() === "desc" ? "descending" : "none" : undefined, children: header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext()) }, header.id))) }, group.id))) }), _jsx(TableBody, { children: rows.length ? rows.map((row) => (_jsx(TableRow, { "data-state": row.getIsSelected() ? "selected" : undefined, children: row.getVisibleCells().map((cell) => (_jsx(TableCell, { children: flexRender(cell.column.columnDef.cell, cell.getContext()) }, cell.id))) }, row.id))) : (_jsx(TableRow, { children: _jsx(TableCell, { colSpan: Math.max(1, table.getVisibleLeafColumns().length), className: "h-24 text-center", children: emptyMessage }) })) })] }) }));
}
export { DataTable, TanStackDataTable };
//# sourceMappingURL=data-table.js.map