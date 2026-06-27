import React, { useState } from "react";
import NeonButton from "../modules/NeonButton";

type Field = {
  name: string;
  label: string;
  type: string;
  placeholder?: string;
  required?: boolean;
};

type GenericEntityFormProps = {
  title: string;
  fields: Field[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  onCancel: () => void;
  initialValues?: Record<string, string>;
  children?: React.ReactNode;
};

export default function GenericEntityForm({
  title,
  fields,
  submitLabel,
  onSubmit,
  onCancel,
  initialValues = {},
  children,
}: GenericEntityFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    fields.forEach((f) => {
      initial[f.name] = initialValues[f.name] ?? "";
    });
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    setValues((v) => ({ ...v, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(values);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        {fields.map((field) => (
          <div key={field.name}>
            <label className="block text-sm font-medium mb-2">
              {field.label}
            </label>
            <input
              name={field.name}
              type={field.type}
              value={values[field.name]}
              onChange={handleChange}
              className="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600"
              placeholder={field.placeholder}
              required={field.required}
            />
          </div>
        ))}
        {children}
        <div className="flex gap-2">
          <NeonButton type="submit" disabled={submitting}>
            {submitLabel}
          </NeonButton>
          <NeonButton cancel onClick={onCancel}>
            Cancel
          </NeonButton>
        </div>
      </form>
    </div>
  );
}
