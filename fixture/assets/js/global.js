const NAV_OPEN_CLASSES = "flex items-center gap-4";

document.addEventListener("DOMContentLoaded", () => {
    const nav = document.querySelector(".site-nav");

    if (nav) nav.className = NAV_OPEN_CLASSES;
});
