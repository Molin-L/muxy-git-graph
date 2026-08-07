import { el } from "./dom.ts";

export type Field =
  | { kind: "text"; id: string; label: string; value?: string; placeholder?: string }
  | { kind: "checkbox"; id: string; label: string; value?: boolean }
  | { kind: "select"; id: string; label: string; value?: string; options: Array<[string, string]> };

export interface DialogSpec {
  readonly title: string;
  readonly message?: string;
  readonly fields?: readonly Field[];
  readonly confirmLabel?: string;
  readonly danger?: boolean;
}

export type DialogResult = Record<string, string | boolean>;

/** Resolves with the field values, or null if dismissed. */
export function openDialog(spec: DialogSpec): Promise<DialogResult | null> {
  return new Promise((resolve) => {
    const overlay = el("div", "overlay");
    const dialog = el("div", "dialog");
    dialog.appendChild(el("h2", "dialog__title", spec.title));
    if (spec.message) dialog.appendChild(el("p", "dialog__message", spec.message));

    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const field of spec.fields ?? []) {
      const row = el("label", "dialog__row");
      if (field.kind === "checkbox") {
        const input = el("input");
        input.type = "checkbox";
        input.checked = field.value === true;
        row.append(input, el("span", "dialog__label", field.label));
        inputs.set(field.id, input);
      } else if (field.kind === "select") {
        row.appendChild(el("span", "dialog__label", field.label));
        const select = el("select");
        for (const [value, label] of field.options) {
          const option = el("option", undefined, label);
          option.value = value;
          select.appendChild(option);
        }
        select.value = field.value ?? field.options[0][0];
        row.appendChild(select);
        inputs.set(field.id, select);
      } else {
        row.appendChild(el("span", "dialog__label", field.label));
        const input = el("input");
        input.type = "text";
        input.value = field.value ?? "";
        if (field.placeholder) input.placeholder = field.placeholder;
        row.appendChild(input);
        inputs.set(field.id, input);
      }
      dialog.appendChild(row);
    }

    const cancel = el("button", "", "Cancel");
    const confirm = el("button", `dialog__confirm${spec.danger ? " dialog__confirm--danger" : ""}`,
      spec.confirmLabel ?? "OK");

    const actions = el("div", "dialog__actions");
    actions.append(cancel, confirm);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const first = [...inputs.values()][0];
    if (first instanceof HTMLInputElement && first.type === "text") first.select();
    else confirm.focus();

    const finish = (result: DialogResult | null): void => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };

    const submit = (): void => {
      const values: DialogResult = {};
      for (const [id, input] of inputs) {
        values[id] = input instanceof HTMLInputElement && input.type === "checkbox"
          ? input.checked
          : input.value;
      }
      finish(values);
    };

    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      } else if (event.key === "Enter" && !(event.target instanceof HTMLSelectElement)) {
        event.preventDefault();
        submit();
      }
    }

    window.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => finish(null));
    confirm.addEventListener("click", submit);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(null);
    });
  });
}

export async function confirmDialog(
  title: string, message: string, confirmLabel: string, danger = false,
): Promise<boolean> {
  return (await openDialog({ title, message, confirmLabel, danger })) !== null;
}
