"use client"

import * as React from "react"
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react"

import { cn } from "@/lib/utils"
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxList,
} from "@/components/ui/combobox"

// A free-text field with suggestions (Base UI Autocomplete): the input's text
// is the value, and picking a suggestion just fills it in. Shares the
// Combobox's input, popup, and list parts, so it looks like every other
// picker in the app.

const Autocomplete = AutocompletePrimitive.Root

function AutocompleteItem({
  className,
  ...props
}: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export {
  Autocomplete,
  ComboboxInput as AutocompleteInput,
  ComboboxContent as AutocompleteContent,
  ComboboxList as AutocompleteList,
  ComboboxEmpty as AutocompleteEmpty,
  AutocompleteItem,
}
