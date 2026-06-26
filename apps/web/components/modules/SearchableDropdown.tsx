import React, { useState, useRef, useEffect } from "react";
import {
  ChevronDownIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";

interface Option {
  label: string;
  value: string;
}

interface SearchableDropdownProps {
  options: Option[];
  placeholder: string;
  onSelect: (option: Option) => void;
  disabled?: boolean;
  className?: string;
  value?: string; // Current selected value
}

export default function SearchableDropdown({
  options,
  placeholder,
  onSelect,
  disabled = false,
  className = "",
  value,
}: SearchableDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedOption, setSelectedOption] = useState<Option | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Set selected option when value prop changes
  useEffect(() => {
    if (value) {
      const option = options.find((opt) => opt.value === value);
      setSelectedOption(option || null);
    } else {
      setSelectedOption(null);
    }
  }, [value, options]);

  // Filter options based on search term
  const filteredOptions = options.filter((option) =>
    option.label.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchTerm("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleSelect = (option: Option) => {
    setSelectedOption(option);
    onSelect(option);
    setIsOpen(false);
    setSearchTerm("");
  };

  const handleToggle = () => {
    if (!disabled) {
      setIsOpen(!isOpen);
      if (!isOpen) {
        setSearchTerm("");
      }
    }
  };

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={`w-full flex items-center justify-between p-3 border rounded-md bg-white dark:bg-gray-700 dark:border-gray-600 ${
          disabled
            ? "opacity-50 cursor-not-allowed"
            : "cursor-pointer hover:border-gray-400"
        }`}
      >
        <span
          className={
            selectedOption ? "text-gray-900 dark:text-white" : "text-gray-500"
          }
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDownIcon
          className={`w-5 h-5 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg max-h-60 overflow-hidden">
          {/* Search input */}
          <div className="p-2 border-b border-gray-200 dark:border-gray-600">
            <div className="relative">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search..."
                className="w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            </div>
          </div>

          {/* Options list */}
          <div className="max-h-48 overflow-y-auto">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleSelect(option)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-600 focus:bg-gray-100 dark:focus:bg-gray-600 focus:outline-none"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-gray-900 dark:text-white">
                      {option.label}
                    </span>
                  </div>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-gray-500 dark:text-gray-400">
                No options found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
