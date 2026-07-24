import { ScrollListItem } from "neonbinder";

export const Default = () => (
  <div className="w-72 flex flex-col">
    <ScrollListItem>2024 Topps Chrome</ScrollListItem>
    <ScrollListItem>2023 Bowman Chrome Draft</ScrollListItem>
    <ScrollListItem>2024 Panini Prizm</ScrollListItem>
    <ScrollListItem withDivider={false}>2022 Topps Update</ScrollListItem>
  </div>
);
