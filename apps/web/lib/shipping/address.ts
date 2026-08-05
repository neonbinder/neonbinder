/**
 * NEO-118 — the one canonical postal-address shape.
 *
 * Both the seller's stored return address and the throwaway recipient address
 * typed on /labels are this type, and both render through
 * {@link formatAddressBlock}. That single formatter is the reason the on-screen
 * preview and the printed label cannot drift: the preview is not a
 * hand-maintained approximation of the label, it is the same lines.
 *
 * `country` is carried even though every value is "US" today. A future address
 * validator or postage carrier needs it in the payload, and adding a required
 * field to a shape that is already persisted is more work than carrying it from
 * the start.
 */

export interface PostalAddress {
  name: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  /** Two-letter USPS state abbreviation. */
  state: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. "US" is the only value produced today. */
  country: string;
}

/** The fields an address cannot be printed without. */
const REQUIRED_FIELDS = [
  "name",
  "line1",
  "city",
  "state",
  "postalCode",
] as const satisfies readonly (keyof PostalAddress)[];

export const EMPTY_ADDRESS: PostalAddress = {
  name: "",
  company: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
};

function present(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * True when every field required to actually address a package is filled in.
 * `company` and `line2` are genuinely optional, and `country` is defaulted
 * rather than typed by the user, so none of them gate printing.
 */
export function isCompleteAddress(
  address: Partial<PostalAddress> | null | undefined,
): boolean {
  if (!address) return false;
  return REQUIRED_FIELDS.every((field) => present(address[field]) !== "");
}

/**
 * Render an address to the lines that get printed, in USPS order:
 *
 *   RECIPIENT NAME
 *   COMPANY            (omitted when blank)
 *   123 MAIN ST
 *   APT 4B             (omitted when blank)
 *   DALLAS TX 75201
 *
 * Uppercased because USPS OCR reads it more reliably that way, and blank
 * optional fields are dropped rather than emitted as empty lines — an empty
 * line in the middle of an address block is what makes a hand-rolled label look
 * hand-rolled.
 *
 * Non-US countries get a trailing country line; "US" does not, matching how
 * domestic mail is actually addressed.
 */
export function formatAddressBlock(
  address: Partial<PostalAddress> | null | undefined,
): string[] {
  if (!address) return [];

  const lines = [
    present(address.name),
    present(address.company),
    present(address.line1),
    present(address.line2),
    [
      present(address.city),
      present(address.state),
      present(address.postalCode),
    ]
      .filter(Boolean)
      .join(" "),
  ];

  const country = present(address.country);
  if (country && country.toUpperCase() !== "US") {
    lines.push(country);
  }

  return lines.filter(Boolean).map((line) => line.toUpperCase());
}
