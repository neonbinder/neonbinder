import { MenuItem, MenuSectionTitle } from "neonbinder";

export const Default = () => (
  <MenuSectionTitle>Marketplaces</MenuSectionTitle>
);

export const WithPaddingLeft = () => (
  <MenuSectionTitle withPaddingLeft>Marketplaces</MenuSectionTitle>
);

export const MarketplaceSection = () => (
  <div className="w-64 rounded-md border border-slate-200 bg-white py-1">
    <MenuSectionTitle withPaddingLeft>Marketplaces</MenuSectionTitle>
    <MenuItem selected rightText="Connected">
      eBay
    </MenuItem>
    <MenuItem rightText="Connected">SportLots</MenuItem>
    <MenuItem disabled rightText="Not connected">
      MyCardPost
    </MenuItem>
  </div>
);
