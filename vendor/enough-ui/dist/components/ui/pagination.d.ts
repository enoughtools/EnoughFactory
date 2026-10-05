import { paginationLinkVariants } from '../../lib/variants.js';
import * as React from "react";
import { type VariantProps } from "class-variance-authority";
declare const Pagination: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>, "ref"> & React.RefAttributes<HTMLElement>>;
declare const PaginationContent: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLUListElement>, HTMLUListElement>, "ref"> & React.RefAttributes<HTMLUListElement>>;
declare const PaginationItem: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.LiHTMLAttributes<HTMLLIElement>, HTMLLIElement>, "ref"> & React.RefAttributes<HTMLLIElement>>;
interface PaginationLinkProps extends React.ComponentPropsWithoutRef<"a">, VariantProps<typeof paginationLinkVariants> {
    asChild?: boolean;
    disabled?: boolean;
    isActive?: boolean;
}
declare const PaginationLink: React.ForwardRefExoticComponent<PaginationLinkProps & React.RefAttributes<HTMLAnchorElement>>;
declare const PaginationPrevious: React.ForwardRefExoticComponent<Omit<PaginationLinkProps & React.RefAttributes<HTMLAnchorElement>, "ref"> & {
    text?: string;
} & React.RefAttributes<HTMLAnchorElement>>;
declare const PaginationNext: React.ForwardRefExoticComponent<Omit<PaginationLinkProps & React.RefAttributes<HTMLAnchorElement>, "ref"> & {
    text?: string;
} & React.RefAttributes<HTMLAnchorElement>>;
declare const PaginationEllipsis: React.ForwardRefExoticComponent<Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLSpanElement>, HTMLSpanElement>, "ref"> & React.RefAttributes<HTMLSpanElement>>;
export { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious, paginationLinkVariants, };
//# sourceMappingURL=pagination.d.ts.map