import { reaction, when, values } from "mobx"
import {
    types,
    recordPatches,
    getSnapshot,
    applySnapshot,
    applyPatch,
    unprotect,
    getRoot,
    onSnapshot,
    flow,
    Instance,
    resolveIdentifier
} from "../../src"
import { expect, test } from "bun:test"

test("it should support custom references - basics", () => {
    const User = types.model({
        id: types.identifier,
        name: types.string
    })
    const UserByNameReference = types.maybeNull(
        types.reference(User, {
            // given an identifier, find the user
            get(identifier, parent): any {
                return (
                    (parent as Instance<typeof Store>)!.users.find(u => u.name === identifier) ||
                    null
                )
            },
            // given a user, produce the identifier that should be stored
            set(value) {
                return value.name
            }
        })
    )
    const Store = types.model({
        users: types.array(User),
        selection: UserByNameReference
    })
    const s = Store.create({
        users: [
            { id: "1", name: "Michel" },
            { id: "2", name: "Mattia" }
        ],
        selection: "Mattia"
    })
    unprotect(s)
    expect(s.selection!.name).toBe("Mattia")
    expect(s.selection === s.users[1]).toBe(true)
    expect(getSnapshot(s).selection).toBe("Mattia")
    s.selection = s.users[0]
    expect(s.selection!.name).toBe("Michel")
    expect(s.selection === s.users[0]).toBe(true)
    expect(getSnapshot(s).selection).toBe("Michel")
    s.selection = null
    expect(getSnapshot(s).selection).toBe(null)
    applySnapshot(s, Object.assign({}, getSnapshot(s), { selection: "Mattia" }))
    // @ts-expect-error - typescript doesn't know that applySnapshot will update the selection
    expect(s.selection).toBe(s.users[1])
    applySnapshot(s, Object.assign({}, getSnapshot(s), { selection: "Unknown" }))
    expect(s.selection).toBe(null)
})

test("it should support custom references - adv", () => {
    const User = types.model({
        id: types.identifier,
        name: types.string
    })
    const NameReference = types.reference(User, {
        get(identifier, parent): any {
            if (identifier === null) return null
            const users = values(getRoot<Instance<typeof Store>>(parent!).users)
            return users.filter(u => u.name === identifier)[0] || null
        },
        set(value) {
            return value ? value.name : ""
        }
    })
    const Store = types.model({
        users: types.map(User),
        selection: NameReference
    })
    const s = Store.create({
        users: {
            "1": { id: "1", name: "Michel" },
            "2": { id: "2", name: "Mattia" }
        },
        selection: "Mattia"
    })
    unprotect(s)
    expect(s.selection.name).toBe("Mattia")
    expect(s.selection === s.users.get("2")).toBe(true)
    expect(getSnapshot<typeof Store.SnapshotType>(s).selection).toBe("Mattia")
    const p = recordPatches(s)
    const r: any[] = []
    onSnapshot(s, r.push.bind(r))
    const ids: (string | null)[] = []
    reaction(
        () => s.selection,
        selection => {
            ids.push(selection ? selection.id : null)
        }
    )
    s.selection = s.users.get("1")!
    expect(s.selection.name).toBe("Michel")
    expect(s.selection === s.users.get("1")).toBe(true)
    expect(getSnapshot(s).selection).toBe("Michel")
    applySnapshot(s, Object.assign({}, getSnapshot(s), { selection: "Mattia" }))
    // @ts-expect-error - typescript doesn't know that applySnapshot will update the selection
    expect(s.selection).toBe(s.users.get("2"))
    applyPatch(s, { op: "replace", path: "/selection", value: "Michel" })
    // @ts-expect-error - typescript doesn't know that applyPatch will update the selection
    expect(s.selection).toBe(s.users.get("1"))
    s.users.delete("1")
    // @ts-expect-error - typescript doesn't know how delete will affect the selection
    expect(s.selection).toBe(null)
    s.users.put({ id: "3", name: "Michel" })
    expect(s.selection.id).toBe("3")
    expect(ids).toMatchSnapshot()
    expect(r).toMatchSnapshot()
    expect(p.patches).toMatchSnapshot()
    expect(p.inversePatches).toMatchSnapshot()
})

test("it should support dynamic loading", async () => {
    const events: string[] = []
    const User = types.model({
        name: types.string,
        age: 0
    })
    const UserByNameReference = types.maybe(
        types.reference(User, {
            get(identifier: string, parent): any {
                return (parent as Instance<typeof Store>).getOrLoadUser(identifier)
            },
            set(value) {
                return value.name
            }
        })
    )
    const Store = types
        .model({
            users: types.array(User),
            selection: UserByNameReference
        })
        .actions(self => ({
            loadUser: flow(function* loadUser(name: string) {
                events.push("loading " + name)
                self.users.push({ name })
                yield new Promise(resolve => {
                    setTimeout(resolve, 200)
                })
                events.push("loaded " + name)
                const user = (self.users.find(u => u.name === name)!.age = name.length * 3) // wonderful!
            })
        }))
        .views(self => ({
            // Important: a view so that the reference will automatically react to the reference being changed!
            getOrLoadUser(name: string) {
                const user = self.users.find(u => u.name === name) || null
                if (!user) {
                    /*
                    TODO: this is ugly, but workaround the idea that views should be side effect free.
                    We need a more elegant solution..
                */
                    setImmediate(() => self.loadUser(name))
                }
                return user
            }
        }))
    const s = Store.create({
        users: [],
        selection: "Mattia"
    })
    unprotect(s)
    expect(events).toEqual([])
    expect(s.users.length).toBe(0)
    // @ts-expect-error - typescript doesn't know that the user will be loaded
    expect(s.selection).toBe(null)

    await when(() => s.users.length === 1 && s.users[0].age === 18 && s.users[0].name === "Mattia")

    expect(s.selection).toBe(s.users[0])
    expect(events).toEqual(["loading Mattia", "loaded Mattia"])
})

test("custom reference / safe custom reference to another store works", () => {
    const Todo = types.model({ id: types.identifier })
    const TodoStore = types.model({ todos: types.array(Todo) })
    const OtherStore = types.model({
        todoRef: types.maybe(
            types.reference(Todo, {
                get(id) {
                    const node = resolveIdentifier(Todo, todos, id)
                    if (!node) {
                        throw new Error("Invalid ref")
                    }
                    return node
                },
                set(value) {
                    return value.id
                }
            })
        ),
        safeRef: types.safeReference(Todo, {
            get(id) {
                const node = resolveIdentifier(Todo, todos, id)
                if (!node) {
                    throw new Error("Invalid ref")
                }
                return node
            },
            set(value) {
                return value.id
            }
        })
    })
    const todos = TodoStore.create({
        todos: [{ id: "1" }, { id: "2" }, { id: "3" }]
    })
    unprotect(todos)

    // from a snapshot
    const otherStore = OtherStore.create({
        todoRef: "1",
        safeRef: "1"
    })
    unprotect(otherStore)
    expect(otherStore.todoRef!.id).toBe("1")
    expect(otherStore.safeRef!.id).toBe("1")

    // assigning an id
    otherStore.todoRef = "2" as any
    otherStore.safeRef = "2" as any
    expect(otherStore.todoRef!.id).toBe("2")
    expect(otherStore.safeRef!.id).toBe("2")

    // assigning a node directly
    otherStore.todoRef = todos.todos[2]
    otherStore.safeRef = todos.todos[2]
    expect(otherStore.todoRef!.id).toBe("3")
    expect(otherStore.safeRef!.id).toBe("3")

    // getting the snapshot
    expect(getSnapshot(otherStore)).toEqual({
        todoRef: "3",
        safeRef: "3"
    })

    // the removed node should throw on standard refs access
    // and be set to undefined on safe ones
    todos.todos.splice(2, 1)
    expect(() => otherStore.todoRef).toThrow("Invalid ref")
    expect(otherStore.safeRef).toBeUndefined()
})
