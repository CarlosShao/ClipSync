import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// 懒加载滚动控制器
class LazyLoadScrollController extends ScrollController {
  final VoidCallback? onLoadMore;
  final double threshold;
  bool _isLoading = false;
  bool _hasMore = true;

  LazyLoadScrollController({
    this.onLoadMore,
    this.threshold = 200.0,
  }) {
    addListener(_onScroll);
  }

  bool get isLoading => _isLoading;
  bool get hasMore => _hasMore;

  void _onScroll() {
    if (position.pixels >= position.maxScrollExtent - threshold) {
      _loadMore();
    }
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore || onLoadMore == null) return;

    _isLoading = true;
    notifyListeners();

    try {
      onLoadMore!();
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void setHasMore(bool value) {
    _hasMore = value;
    notifyListeners();
  }

  void reset() {
    _isLoading = false;
    _hasMore = true;
    notifyListeners();
  }

  @override
  void dispose() {
    removeListener(_onScroll);
    super.dispose();
  }
}

/// 懒加载列表视图
class LazyLoadListView extends StatelessWidget {
  final LazyLoadScrollController controller;
  final IndexedWidgetBuilder itemBuilder;
  final int itemCount;
  final Widget? loadingWidget;
  final Widget? emptyWidget;
  final Widget? endWidget;
  final EdgeInsetsGeometry? padding;
  final ScrollPhysics? physics;
  final Axis scrollDirection;
  final bool reverse;

  const LazyLoadListView({
    Key? key,
    required this.controller,
    required this.itemBuilder,
    required this.itemCount,
    this.loadingWidget,
    this.emptyWidget,
    this.endWidget,
    this.padding,
    this.physics,
    this.scrollDirection = Axis.vertical,
    this.reverse = false,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    if (itemCount == 0 && emptyWidget != null) {
      return emptyWidget!;
    }

    return ListenableBuilder(
      listenable: controller,
      builder: (context, child) {
        return ListView.builder(
          controller: controller,
          itemCount: itemCount + (controller.hasMore ? 1 : 0),
          padding: padding,
          physics: physics,
          scrollDirection: scrollDirection,
          reverse: reverse,
          itemBuilder: (context, index) {
            if (index == itemCount) {
              // 加载更多指示器
              if (controller.isLoading) {
                return loadingWidget ?? _buildLoadingWidget();
              } else if (!controller.hasMore && endWidget != null) {
                return endWidget!;
              } else {
                return const SizedBox.shrink();
              }
            }
            return itemBuilder(context, index);
          },
        );
      },
    );
  }

  Widget _buildLoadingWidget() {
    return const Padding(
      padding: EdgeInsets.all(16.0),
      child: Center(
        child: CircularProgressIndicator(),
      ),
    );
  }
}

/// 懒加载网格视图
class LazyLoadGridView extends StatelessWidget {
  final LazyLoadScrollController controller;
  final IndexedWidgetBuilder itemBuilder;
  final int itemCount;
  final SliverGridDelegate gridDelegate;
  final Widget? loadingWidget;
  final Widget? emptyWidget;
  final Widget? endWidget;
  final EdgeInsetsGeometry? padding;
  final ScrollPhysics? physics;
  final Axis scrollDirection;
  final bool reverse;

  const LazyLoadGridView({
    Key? key,
    required this.controller,
    required this.itemBuilder,
    required this.itemCount,
    required this.gridDelegate,
    this.loadingWidget,
    this.emptyWidget,
    this.endWidget,
    this.padding,
    this.physics,
    this.scrollDirection = Axis.vertical,
    this.reverse = false,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    if (itemCount == 0 && emptyWidget != null) {
      return emptyWidget!;
    }

    return ListenableBuilder(
      listenable: controller,
      builder: (context, child) {
        return GridView.builder(
          controller: controller,
          gridDelegate: gridDelegate,
          itemCount: itemCount + (controller.hasMore ? 1 : 0),
          padding: padding,
          physics: physics,
          scrollDirection: scrollDirection,
          reverse: reverse,
          itemBuilder: (context, index) {
            if (index == itemCount) {
              // 加载更多指示器
              if (controller.isLoading) {
                return loadingWidget ?? _buildLoadingWidget();
              } else if (!controller.hasMore && endWidget != null) {
                return endWidget!;
              } else {
                return const SizedBox.shrink();
              }
            }
            return itemBuilder(context, index);
          },
        );
      },
    );
  }

  Widget _buildLoadingWidget() {
    return const Padding(
      padding: EdgeInsets.all(16.0),
      child: Center(
        child: CircularProgressIndicator(),
      ),
    );
  }
}

/// 懭加载图片
class LazyLoadImage extends StatefulWidget {
  final String? imageUrl;
  final String? assetPath;
  final double? width;
  final double? height;
  final BoxFit fit;
  final Widget? placeholder;
  final Widget? errorWidget;
  final bool enableMemoryCache;
  final Duration memoryCacheDuration;

  const LazyLoadImage({
    Key? key,
    this.imageUrl,
    this.assetPath,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
    this.placeholder,
    this.errorWidget,
    this.enableMemoryCache = true,
    this.memoryCacheDuration = const Duration(minutes: 5),
  }) : assert(imageUrl != null || assetPath != null),
       super(key: key);

  @override
  State<LazyLoadImage> createState() => _LazyLoadImageState();
}

class _LazyLoadImageState extends State<LazyLoadImage> {
  bool _isVisible = false;
  bool _isLoading = false;
  bool _hasError = false;
  ImageProvider? _imageProvider;

  @override
  void initState() {
    super.initState();
    if (widget.assetPath != null) {
      _imageProvider = AssetImage(widget.assetPath!);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_isVisible) {
      _checkVisibility();
    }
  }

  void _checkVisibility() {
    final renderObject = context.findRenderObject();
    if (renderObject is RenderBox) {
      final viewport = RenderAbstractViewport.of(renderObject);
      if (viewport != null) {
        final objectOffset = renderObject.localToGlobal(Offset.zero);
        final viewportSize = viewport.paintBounds.size;
        
        // Check if the object's top is within visible area
        if (objectOffset.dy < viewportSize.height && objectOffset.dy + renderObject.size.height > 0) {
          setState(() {
            _isVisible = true;
          });
          _loadImage();
        }
      }
    }
  }

  void _loadImage() {
    if (_imageProvider != null || widget.imageUrl == null) return;

    setState(() {
      _isLoading = true;
      _hasError = false;
    });

    _imageProvider = NetworkImage(widget.imageUrl!);
    
    // 预加载图片
    _imageProvider!.resolve(const ImageConfiguration()).addListener(
      ImageStreamListener(
        (_, __) {
          if (mounted) {
            setState(() {
              _isLoading = false;
            });
          }
        },
        onError: (error, stackTrace) {
          if (mounted) {
            setState(() {
              _isLoading = false;
              _hasError = true;
            });
          }
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_hasError) {
      return widget.errorWidget ?? _buildErrorWidget();
    }

    if (_imageProvider == null) {
      return widget.placeholder ?? _buildPlaceholderWidget();
    }

    return Image(
      image: _imageProvider!,
      width: widget.width,
      height: widget.height,
      fit: widget.fit,
      frameBuilder: (context, child, frame, wasSynchronouslyLoaded) {
        if (wasSynchronouslyLoaded) return child;
        
        return AnimatedOpacity(
          opacity: frame == null ? 0 : 1,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
          child: child,
        );
      },
      loadingBuilder: (context, child, loadingProgress) {
        if (loadingProgress == null) return child;
        
        return widget.placeholder ?? _buildLoadingWidget();
      },
      errorBuilder: (context, error, stackTrace) {
        return widget.errorWidget ?? _buildErrorWidget();
      },
    );
  }

  Widget _buildPlaceholderWidget() {
    return Container(
      width: widget.width,
      height: widget.height,
      color: Colors.grey[200],
      child: const Icon(
        Icons.image,
        color: Colors.grey,
      ),
    );
  }

  Widget _buildLoadingWidget() {
    return Container(
      width: widget.width,
      height: widget.height,
      color: Colors.grey[200],
      child: const Center(
        child: CircularProgressIndicator(),
      ),
    );
  }

  Widget _buildErrorWidget() {
    return Container(
      width: widget.width,
      height: widget.height,
      color: Colors.grey[200],
      child: const Icon(
        Icons.error_outline,
        color: Colors.red,
      ),
    );
  }
}

/// 懒加载滚动通知
class LazyLoadNotification extends Notification {
  final bool isLoading;
  final bool hasMore;

  LazyLoadNotification({
    required this.isLoading,
    required this.hasMore,
  });
}

/// 懒加载包装器
class LazyLoadWrapper extends StatefulWidget {
  final Widget child;
  final VoidCallback? onLoadMore;
  final double threshold;
  final bool enabled;

  const LazyLoadWrapper({
    Key? key,
    required this.child,
    this.onLoadMore,
    this.threshold = 200.0,
    this.enabled = true,
  }) : super(key: key);

  @override
  State<LazyLoadWrapper> createState() => _LazyLoadWrapperState();
}

class _LazyLoadWrapperState extends State<LazyLoadWrapper> {
  late ScrollController _scrollController;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _scrollController = ScrollController();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!widget.enabled || _isLoading) return;

    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - widget.threshold) {
      _loadMore();
    }
  }

  Future<void> _loadMore() async {
    if (_isLoading || widget.onLoadMore == null) return;

    setState(() {
      _isLoading = true;
    });

    try {
      widget.onLoadMore!();
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification is ScrollEndNotification) {
          _onScroll();
        }
        return false;
      },
      child: SingleChildScrollView(
        controller: _scrollController,
        child: widget.child,
      ),
    );
  }
}