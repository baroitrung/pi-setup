/**
 * Environment parsing shared by the working and thinking settings resolvers.
 * Invalid or empty values mean "unset", matching pi-pretty's config conventions.
 */

export function envFlag(value: string | undefined): boolean | undefined {
	const v = value?.trim().toLowerCase();
	if (!v) return undefined;
	if (v === "off" || v === "false" || v === "0") return false;
	if (v === "on" || v === "true" || v === "1") return true;
	return undefined;
}
