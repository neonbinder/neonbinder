import { TableItem } from "neonbinder";

export const Default = () => (
  <table className="w-full border-collapse">
    <thead>
      <tr>
        <TableItem type="head">Card</TableItem>
        <TableItem type="head">Set</TableItem>
        <TableItem type="head">Grade</TableItem>
        <TableItem type="head">Price</TableItem>
      </tr>
    </thead>
    <tbody>
      <tr>
        <TableItem type="item">Mike Trout</TableItem>
        <TableItem type="item">2011 Topps Update</TableItem>
        <TableItem type="item">PSA 10</TableItem>
        <TableItem type="item">$420.00</TableItem>
      </tr>
      <tr>
        <TableItem type="item" selected>
          Shohei Ohtani
        </TableItem>
        <TableItem type="item" selected>
          2018 Bowman Chrome
        </TableItem>
        <TableItem type="item" selected>
          BGS 9.5
        </TableItem>
        <TableItem type="item" selected>
          $310.00
        </TableItem>
      </tr>
      <tr>
        <TableItem type="item">Ken Griffey Jr.</TableItem>
        <TableItem type="item">1989 Upper Deck</TableItem>
        <TableItem type="item">Raw</TableItem>
        <TableItem type="item">$45.00</TableItem>
      </tr>
    </tbody>
  </table>
);
