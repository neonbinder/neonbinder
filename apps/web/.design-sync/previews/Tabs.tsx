import { Tabs, TabsList, TabsTrigger, TabsContent } from "neonbinder";

export const Default = () => (
  <Tabs defaultValue="collection">
    <TabsList>
      <TabsTrigger value="collection">Collection</TabsTrigger>
      <TabsTrigger value="listings">Listings</TabsTrigger>
      <TabsTrigger value="sold">Sold</TabsTrigger>
    </TabsList>
    <TabsContent value="collection">
      <p className="text-sm text-slate-700">142 cards in your collection.</p>
    </TabsContent>
    <TabsContent value="listings">
      <p className="text-sm text-slate-700">18 active marketplace listings.</p>
    </TabsContent>
    <TabsContent value="sold">
      <p className="text-sm text-slate-700">63 cards sold this year.</p>
    </TabsContent>
  </Tabs>
);

export const SecondTabActive = () => (
  <Tabs defaultValue="listings">
    <TabsList>
      <TabsTrigger value="collection">Collection</TabsTrigger>
      <TabsTrigger value="listings">Listings</TabsTrigger>
      <TabsTrigger value="sold" disabled>
        Sold
      </TabsTrigger>
    </TabsList>
    <TabsContent value="collection">
      <p className="text-sm text-slate-700">142 cards in your collection.</p>
    </TabsContent>
    <TabsContent value="listings">
      <p className="text-sm text-slate-700">18 active marketplace listings.</p>
    </TabsContent>
    <TabsContent value="sold">
      <p className="text-sm text-slate-700">63 cards sold this year.</p>
    </TabsContent>
  </Tabs>
);
