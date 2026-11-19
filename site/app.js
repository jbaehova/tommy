// The example chats of the product window on the landing page. Every name and message is invented.

const PDF = { name: "tokyo-trip.pdf", size: "1.2 MB" };

const CHATS = [
  {
    id: "tommy",
    name: "Tommy",
    avatar: "avatars/tommy.svg",
    messages: [
      { day: "Today" },
      { out: "Plan a 5-day trip to Tokyo for two in April. Budget $2,000, not counting flights.", time: "10:02" },
      {
        text: "On it. I split the work:\nTravel Planner: a day-by-day plan\nFinance: the budget\nResearcher: the cherry blossoms\nWriter: a one-page guide",
        time: "10:02",
      },
      { service: "Tommy handed work to 4 agents" },
      {
        text: "Your trip is ready. 5 days for $1,840, so $160 stays in the budget. Ueno Park is on day 2, for the cherry blossoms.",
        file: PDF,
        time: "10:21",
      },
      { out: "Perfect. Remind me to book the hotel on Friday.", time: "10:23" },
      { text: "Done. I made a routine for Friday at 9:00.", time: "10:24" },
    ],
  },
  {
    id: "travel",
    name: "Travel Planner",
    avatar: "avatars/travel.jpg",
    messages: [
      { day: "Today" },
      { from: "From Tommy", text: "Plan 5 days in Tokyo for two in April. Keep it walkable.", time: "10:03" },
      {
        from: "To Tommy",
        text: "Day 1: Asakusa and Senso-ji\nDay 2: Ueno Park and the museums\nDay 3: Shibuya and Harajuku\nDay 4: A day trip to Hakone\nDay 5: Tsukiji, then the airport",
        time: "10:12",
      },
      { out: "Can day 4 be more relaxed?", time: "10:30" },
      { text: "Sure. Day 4 is now a slow morning at a hot spring in Hakone, and an early train back.", time: "10:31" },
    ],
  },
  {
    id: "finance",
    name: "Finance",
    avatar: "avatars/finance.jpg",
    messages: [
      { day: "Today" },
      { from: "From Tommy", text: "Check a $2,000 budget for 5 nights in Tokyo for two.", time: "10:03" },
      {
        from: "To Tommy",
        text: "Hotel, 5 nights: $900\nFood: $520\nTrains and metro: $160\nTickets and museums: $260\n\nTotal $1,840. You stay $160 under budget.",
        time: "10:09",
      },
    ],
  },
  {
    id: "engineer",
    name: "Engineer",
    avatar: "avatars/engineer.jpg",
    unread: 2,
    messages: [
      { day: "Today" },
      { out: "The checkout page is slow on phones. Can you take a look?", time: "09:20" },
      { text: "Found it. The product photos load at full size, 4 MB each.", time: "09:41" },
      {
        text: "I resized them and opened pull request #42. The page now loads in 1.2 seconds, not 4.8.",
        time: "09:47",
      },
    ],
  },
  {
    id: "researcher",
    name: "Researcher",
    avatar: "avatars/researcher.jpg",
    messages: [
      { day: "Today" },
      {
        from: "From Tommy",
        text: "When do the cherry blossoms open in Tokyo, and where are they best?",
        time: "10:03",
      },
      {
        from: "To Tommy",
        text: "They usually peak from late March to early April. Ueno Park and the Meguro River are the classic spots. Go early in the morning to miss the crowds.",
        time: "10:07",
      },
    ],
  },
  {
    id: "designer",
    name: "Designer",
    avatar: "avatars/designer.jpg",
    unread: 1,
    messages: [
      { day: "Today" },
      { from: "From Writer", text: "Can you make a cover for the Tokyo guide?", time: "10:16" },
      { from: "To Writer", text: "Here are two covers. I like the pink one.", covers: true, time: "10:19" },
    ],
  },
  {
    id: "writer",
    name: "Writer",
    avatar: "avatars/writer.jpg",
    messages: [
      { day: "Today" },
      { from: "From Tommy", text: "Turn the plan, the budget and the tips into a one-page guide.", time: "10:13" },
      { from: "To Designer", text: "Can you make a cover for the Tokyo guide?", time: "10:16" },
      { from: "To Tommy", text: "Here is the guide, with the cover from Designer.", file: PDF, time: "10:20" },
    ],
  },
];

const SVG = "http://www.w3.org/2000/svg";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function readChecks() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "checks-read");
  svg.setAttribute("viewBox", "0 0 16 10");
  svg.setAttribute("aria-label", "Read");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M1 5.5 3.8 8.3 10 1.7M6.5 7.6l.7.7L13.4 1.7");
  svg.append(path);
  return svg;
}

function lastMessage(chat) {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (message.time) return message;
  }
  return chat.messages[0];
}

function previewText(message) {
  if (message.covers) return "Photo";
  if (message.file && !message.text) return message.file.name;
  return (message.out ?? message.text).split("\n")[0];
}

function renderMessage(message, index) {
  if (message.day) return element("p", "day", message.day);
  if (message.service) return element("p", "service", message.service);

  const outgoing = Boolean(message.out);
  const bubble = element("p", `bubble ${outgoing ? "out" : "in"}`);
  bubble.style.animationDelay = `${Math.min(index, 8) * 45}ms`;
  if (message.from) bubble.append(element("span", "from", message.from));
  bubble.append(document.createTextNode(message.out ?? message.text));

  if (message.covers) {
    const covers = element("span", "covers");
    covers.append(element("span", "cover a", "Tokyo in spring"), element("span", "cover b", "5 days in Tokyo"));
    bubble.append(covers);
  }

  if (message.file) {
    const file = element("span", "file");
    const badge = element("span", "file-icon");
    badge.append(icon("file"));
    const label = element("span");
    label.append(element("strong", "", message.file.name), element("small", "", message.file.size));
    file.append(badge, label);
    bubble.append(file);
  }

  const meta = element("span", "meta", message.time);
  if (outgoing) meta.append(readChecks());
  bubble.append(meta);
  return bubble;
}

function typing() {
  const node = element("p", "typing");
  node.setAttribute("aria-label", "Typing");
  node.append(element("i"), element("i"), element("i"));
  return node;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function setupDemo() {
  const list = document.querySelector("#demo .chats");
  const messages = document.getElementById("messages");
  const headName = document.getElementById("head-name");
  const headAvatar = document.getElementById("head-avatar");
  const replay = document.getElementById("replay");
  if (!list || !messages || !headName || !headAvatar) return;

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rows = new Map();
  let current = CHATS[0];
  let run = 0;

  // Plays the chat one message at a time, with a typing dot before each answer.
  async function play(chat) {
    run += 1;
    const token = run;
    messages.replaceChildren();
    for (const message of chat.messages) {
      if (!message.out && !message.day && !message.service) {
        const dots = typing();
        messages.append(dots);
        await wait(700);
        dots.remove();
      }
      if (token !== run) return;
      messages.append(renderMessage(message, 0));
      await wait(message.out ? 650 : 450);
      if (token !== run) return;
    }
  }

  function open(chat, animate) {
    current = chat;
    run += 1;
    for (const [id, row] of rows) row.setAttribute("aria-current", String(id === chat.id));
    chat.unread = 0;
    rows.get(chat.id)?.querySelector(".badge")?.remove();
    headName.textContent = chat.name;
    headAvatar.src = chat.avatar;
    if (animate && !still) {
      void play(chat);
    } else {
      messages.replaceChildren(...chat.messages.map(renderMessage));
    }
  }

  for (const chat of CHATS) {
    const last = lastMessage(chat);
    const row = element("button", "chat-row");
    row.type = "button";
    const avatar = element("img", "avatar");
    avatar.src = chat.avatar;
    avatar.alt = "";
    avatar.width = 48;
    avatar.height = 48;
    row.append(
      avatar,
      element("span", "name", chat.name),
      element("span", "time", last.time ?? ""),
      element("span", "preview", previewText(last)),
    );
    if (chat.unread) row.append(element("span", "badge", String(chat.unread)));
    row.addEventListener("click", () => open(chat, false));
    rows.set(chat.id, row);
    const item = element("li");
    item.append(row);
    list.append(item);
  }

  replay?.addEventListener("click", () => open(current, true));

  // Show the first chat at once, then play it when the window scrolls into view.
  open(CHATS[0], false);
  if ("IntersectionObserver" in window && !still) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        if (current === CHATS[0]) open(CHATS[0], true);
      },
      { threshold: 0.45 },
    );
    observer.observe(messages);
  }
}

function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const other of tabs) {
        const selected = other === tab;
        other.setAttribute("aria-selected", String(selected));
        const panel = document.getElementById(other.getAttribute("aria-controls") ?? "");
        if (panel) panel.hidden = !selected;
      }
    });
  }
}

function setupCopy() {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const text = document.getElementById(button.dataset.copy)?.textContent ?? "";
      const use = button.querySelector("use");
      try {
        await navigator.clipboard.writeText(text);
        button.classList.add("done");
        use?.setAttribute("href", "#i-check");
      } catch {
        button.setAttribute("aria-label", "Select the text to copy");
      }
      setTimeout(() => {
        button.classList.remove("done");
        use?.setAttribute("href", "#i-copy");
      }, 1600);
    });
  }
}

setupDemo();
setupTabs();
setupCopy();
