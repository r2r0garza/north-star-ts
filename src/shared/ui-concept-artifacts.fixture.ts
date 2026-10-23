// Shared test fixture: the documented PR116 example, extended with tabs/table.
export const conceptInput = {
  title: "Notification settings concept",
  description: "A compact settings layout with grouped preferences.",
  tree: {
    type: "stack",
    gap: "lg",
    children: [
      { type: "text", role: "heading", text: "Notifications" },
      {
        type: "tabs",
        tabs: [
          {
            label: "Email",
            children: [
              {
                type: "card",
                title: "Digest",
                children: [
                  {
                    type: "field",
                    label: "Weekly summary",
                    orientation: "horizontal",
                    control: { type: "switch", defaultChecked: true },
                  },
                  {
                    type: "field",
                    label: "Frequency",
                    control: {
                      type: "select",
                      options: ["Daily", "Weekly"],
                      defaultValue: "Weekly",
                    },
                  },
                ],
              },
            ],
          },
          {
            label: "Team",
            children: [
              {
                type: "table",
                columns: ["Member", "Role"],
                rows: [["Ana", ""]],
              },
            ],
          },
        ],
      },
      {
        type: "row",
        justify: "end",
        children: [{ type: "button", text: "Save", variant: "default" }],
      },
    ],
  },
}
