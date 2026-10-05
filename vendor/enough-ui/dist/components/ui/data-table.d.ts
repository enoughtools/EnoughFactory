import * as React from "react";
import { type Table as TanStackTable } from "@tanstack/react-table";
type SortDirection = "asc" | "desc";
type DataTableColumn<TData> = {
    id: string;
    header: React.ReactNode;
    accessorKey?: keyof TData;
    cell?: (row: TData) => React.ReactNode;
    sortable?: boolean;
    align?: "left" | "center" | "right";
    className?: string;
    headerClassName?: string;
};
type DataTableProps<TData> = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
    columns: DataTableColumn<TData>[];
    data: TData[];
    getRowId: (row: TData) => string;
    caption?: string;
    emptyMessage?: string;
    pageSize?: number;
    searchKey?: keyof TData;
    searchPlaceholder?: string;
    selectable?: boolean;
    initialSort?: {
        columnId: string;
        direction?: SortDirection;
    };
    onSelectionChange?: (rows: TData[]) => void;
};
declare function DataTable<TData>({ columns, data, getRowId, caption, emptyMessage, pageSize, searchKey, searchPlaceholder, selectable, initialSort, onSelectionChange, className, ...props }: DataTableProps<TData>): React.JSX.Element;
type TanStackDataTableProps<TData> = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
    /** A table created by useReactTable; filtering, sorting and pagination stay in your control. */
    table: TanStackTable<TData>;
    caption?: React.ReactNode;
    emptyMessage?: React.ReactNode;
};
/** Renders TanStack's current row model using EnoughUI's Table primitives. */
declare function TanStackDataTable<TData>({ table, caption, emptyMessage, className, ...props }: TanStackDataTableProps<TData>): React.JSX.Element;
export { DataTable, TanStackDataTable };
export type { DataTableColumn, DataTableProps, SortDirection, TanStackDataTableProps };
//# sourceMappingURL=data-table.d.ts.map