# Native single/batch Item DELETE boundary

The neutral input contains request, claim, type, user-policy and controlled deletion-fault scenarios, not candidate-produced expected results. `Program.cs` hosts the actual loaded `LibraryController` in isolated ASP.NET Core MVC with native `AddJellyfinApi` options/formatters, Guid and comma-collection binding, client-error mapping and `ExceptionMiddleware`.

Concrete native `LibraryManager.GetItemById<T>(id,user)`, `IsVisibleStandalone`, collection membership, media path protocol and each typed `CanDelete(User)` execute. Principal/default authorization policy, user/repository lookup and `DeleteItem` persistence/fault boundaries are explicitly controlled. They do not prove native authentication policy handlers or the filesystem/SQL delete lifecycle; those use independent core fixtures. No synthetic path is opened as media. The host binds only loopback and is stopped after capture.

Selected clean-pin sources and actual loaded assemblies are sealed independently. Their identity does not close the dirty reference workspace's complete build-input closure. This is not full server, POSIX, browser, exchange or final release acceptance.
