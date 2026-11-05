// window.tommy belongs in the application adapter.
export const documentation = "window.tommy";
export const viewport = () => window.innerWidth;
export const platformAction = (props: { tommy: () => void }) => props.tommy();
