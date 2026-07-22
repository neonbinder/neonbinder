import { Input } from "neonbinder";

export const Default = () => (
  <div className="w-72">
    <Input
      label="Set name"
      placeholder="2023 Topps Chrome"
      helperText="Used to match cards during bulk import"
    />
  </div>
);

export const WithButton = () => (
  <div className="w-80">
    <Input
      label="eBay listing price"
      variant="withButton"
      buttonText="Apply to all"
      defaultValue="24.99"
    />
  </div>
);

export const ErrorState = () => (
  <div className="w-72">
    <Input
      label="Card number"
      defaultValue="ABC"
      error="Card number must be numeric"
    />
  </div>
);

export const Disabled = () => (
  <div className="w-72">
    <Input
      label="SKU"
      state="disabled"
      defaultValue="NB-2023TC-042"
      helperText="Auto-generated, cannot be edited"
    />
  </div>
);

export const LabelLeft = () => (
  <div className="w-96">
    <Input
      label="Grade"
      labelPosition="left"
      defaultValue="PSA 10"
      inputSize="small"
    />
  </div>
);
