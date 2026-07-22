import { MenuItem } from "neonbinder";

const GridIcon = () => (
  <svg
    className="w-4 h-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const TagIcon = () => (
  <svg
    className="w-4 h-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M20.25 7.5l-9-4.5-9 4.5 9 4.5 9-4.5zM3.75 7.5v9l9 4.5 9-4.5v-9"
    />
  </svg>
);

export const Default = () => (
  <MenuItem>2024 Topps Chrome Baseball</MenuItem>
);

export const BinderMenu = () => (
  <div className="w-64 rounded-md border border-slate-200 bg-white py-1">
    <MenuItem leftIcon={<GridIcon />}>All Collections</MenuItem>
    <MenuItem selected leftIcon={<TagIcon />}>
      Active Listings
    </MenuItem>
    <MenuItem rightText="128">Vintage Baseball</MenuItem>
    <MenuItem disabled rightText="Sold out">
      2023 Prizm Basketball
    </MenuItem>
  </div>
);
