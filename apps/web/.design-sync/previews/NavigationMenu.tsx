import { NavigationMenu, NavigationMenuItem, NavigationMenuContent } from "neonbinder";
import { NavigationMenuContentItem } from "../../components/primitives/NavigationMenu";

export const Default = () => (
  <NavigationMenu>
    <NavigationMenuItem value="collection" type="default">
      Collection
    </NavigationMenuItem>
    <NavigationMenuItem value="marketplaces" type="dropdown">
      Marketplaces
    </NavigationMenuItem>
    <NavigationMenuItem value="settings" type="link">
      Settings
    </NavigationMenuItem>
    <NavigationMenuContent value="marketplaces" type="twoColumns">
      <NavigationMenuContentItem
        title="eBay"
        description="Sync active listings and sold prices."
      />
      <NavigationMenuContentItem
        title="SportLots"
        description="Push new cards straight to your store."
      />
      <NavigationMenuContentItem
        title="BuySportsCards"
        description="Manage BSC inventory from one place."
        selected
      />
      <NavigationMenuContentItem
        title="MySlabs"
        description="List graded cards with slab photos."
      />
    </NavigationMenuContent>
  </NavigationMenu>
);
