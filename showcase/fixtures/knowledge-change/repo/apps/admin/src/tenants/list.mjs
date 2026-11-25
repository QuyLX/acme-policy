export const sortUsers = (users) => [...users].sort((a, b) => a.name.localeCompare(b.name));
