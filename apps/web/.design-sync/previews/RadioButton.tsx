import { RadioButton } from "neonbinder";

export const Default = () => (
  <RadioButton name="preview-radio-default" label="Ungraded" />
);

export const CheckedNoLabel = () => (
  <RadioButton name="preview-radio-nolabel" checked readOnly />
);

export const ConditionGroup = () => (
  <div className="flex flex-col gap-2">
    <RadioButton name="condition" label="Raw / Ungraded" checked readOnly />
    <RadioButton name="condition" label="PSA Graded" readOnly />
    <RadioButton name="condition" label="BGS Graded" readOnly />
  </div>
);

export const MarketplaceGroup = () => (
  <div className="flex flex-col gap-2">
    <RadioButton name="listing-destination" label="eBay" readOnly />
    <RadioButton
      name="listing-destination"
      label="SportLots"
      checked
      readOnly
    />
    <RadioButton name="listing-destination" label="BuySportsCards" readOnly />
  </div>
);
